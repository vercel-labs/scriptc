/* IR validation — runs on every compile as the backstop for frontend bugs.
 * A violation is an internal compiler error (the frontend should never
 * produce invalid IR), but it still carries the user's source location:
 * an ICE that points at source is a gift to whoever debugs it.
 */
import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrGlobal,
  IrLibFn,
  IrModule,
  IrRecordShape,
  IrRegexIntrinsicMethod,
  IrStmt,
  IrStrIntrinsicMethod,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "./nodes.js";
import { arrayOf, BOOL, BYTES_U8, bytesOf, canAdaptDynFuncTo, canConvertToDyn, canExitIslandToType, canMarshalIntoIsland, canMarshalTypedFuncIntoIsland, CHILD_T, CHILDSTREAM_T, DATE_T, DGRAMSOCK_T, DYN, DYN_HANDLE_KINDS, F64, ffiClassType, ffiSourceParamTypes, FILEHANDLE_T, FSWATCHER_T, HTTP2SESSION_T, HTTP2STREAM_T, HTTPCLIENTREQ_T, HTTPREQ_T, HTTPRES_T, islandPromisePayloadTag, isJsonSafeType, isRefCounted, isSupportedIndexValue, isSupportedMapKey, isSupportedMapValue, isSupportedSetElem, isUnitType, jsOpResultKind, JSVAL, NETSERVER_T, NETSOCKET_T, PROCSTREAM_T, REF_TRUTHY_KINDS, REGEX, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, SEARCH_PARAMS_T, SECURECTX_T, SPAWNRES_T, STATS_T, STRING, SYMBOL_T, TESTCTX_T, typeEquals, typeKey, unionFuncSetArmsOk, URL_T, VOID } from "./nodes.js";

/** Per-method signature for strIntrinsic: `argTypes` lists every argument
 * position (optional ones included); `minArgs` is how many may be omitted
 * from the end (backends fill the documented defaults). Exported for the
 * frontend's lib-boundary pass (lib-boundary.ts), which coerces or fences
 * checked-dynamic arguments against the same table the validator enforces. */
export const STR_INTRINSIC_SIGS: Record<
  IrStrIntrinsicMethod,
  { argTypes: IrType[]; minArgs: number; result: IrType }
> = {
  length: { argTypes: [], minArgs: 0, result: F64 },
  charCodeAt: { argTypes: [F64], minArgs: 1, result: F64 },
  charAt: { argTypes: [F64], minArgs: 1, result: STRING },
  indexOf: { argTypes: [STRING, F64], minArgs: 1, result: F64 },
  includes: { argTypes: [STRING, F64], minArgs: 1, result: BOOL },
  startsWith: { argTypes: [STRING], minArgs: 1, result: BOOL },
  endsWith: { argTypes: [STRING], minArgs: 1, result: BOOL },
  slice: { argTypes: [F64, F64], minArgs: 0, result: STRING },
  substring: { argTypes: [F64, F64], minArgs: 1, result: STRING },
  repeat: { argTypes: [F64], minArgs: 1, result: STRING },
  trim: { argTypes: [], minArgs: 0, result: STRING },
  trimStart: { argTypes: [], minArgs: 0, result: STRING },
  trimEnd: { argTypes: [], minArgs: 0, result: STRING },
  split: { argTypes: [STRING, F64], minArgs: 2, result: arrayOf(STRING) },
  padStart: { argTypes: [F64, STRING], minArgs: 2, result: STRING },
  padEnd: { argTypes: [F64, STRING], minArgs: 2, result: STRING },
  toLowerCase: { argTypes: [], minArgs: 0, result: STRING },
  toUpperCase: { argTypes: [], minArgs: 0, result: STRING },
  isWellFormed: { argTypes: [], minArgs: 0, result: BOOL },
  toWellFormed: { argTypes: [], minArgs: 0, result: STRING },
  cpAt: { argTypes: [F64], minArgs: 1, result: STRING },
};

/** Per-method signature for regexIntrinsic. test/source/flags take the
 * regex as receiver; replace/replaceAll/split take the STRING as receiver
 * with the regex as args[0] (mirroring the source syntax). All positions
 * are required — the surface has no optionals. */
export const REGEX_INTRINSIC_SIGS: Record<
  IrRegexIntrinsicMethod,
  { receiver: IrType; argTypes: IrType[]; result: IrType }
> = {
  test: { receiver: REGEX, argTypes: [STRING], result: BOOL },
  // match's result is the program-dependent `string[] | null` union —
  // VOID here is the process.envGet sentinel; the regexIntrinsic case
  // checks the union's arms.
  match: { receiver: STRING, argTypes: [REGEX], result: VOID },
  matchAll: { receiver: STRING, argTypes: [REGEX], result: arrayOf(arrayOf(STRING)) },
  matchAllInto: { receiver: STRING, argTypes: [REGEX, arrayOf(F64)], result: arrayOf(arrayOf(STRING)) },
  search: { receiver: STRING, argTypes: [REGEX], result: F64 },
  source: { receiver: REGEX, argTypes: [], result: STRING },
  flags: { receiver: REGEX, argTypes: [], result: STRING },
  replace: { receiver: STRING, argTypes: [REGEX, STRING], result: STRING },
  replaceAll: { receiver: STRING, argTypes: [REGEX, STRING], result: STRING },
  split: { receiver: STRING, argTypes: [REGEX, F64], result: arrayOf(STRING) },
};

/** Closed-union signature table for `libCall` (mirrors ambient/scriptc.d.ts).
 * All argument positions are required — the surface has no optionals.
 * readFileSync's second argument is the (always-"utf8") encoding: it is
 * evaluated for JS-exact side-effect order and ignored by the runtime.
 * A `null` argument slot is program-dependent (a builtin-error receiver) —
 * the libCall case checks it specially, like process.envGet's result.
 * Exported for the frontend's lib-boundary pass (lib-boundary.ts). */
export const LIB_FN_SIGS: Record<IrLibFn, { argTypes: (IrType | null)[]; result: IrType }> = {
  "fetch.start": { argTypes: [STRING, DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseNew": { argTypes: [DYN, DYN], result: DYN },
  "fetch.responseJson": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseText": { argTypes: [DYN], result: { kind: "promise", inner: STRING } },
  "fetch.responseBytes": { argTypes: [DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "fetch.abortControllerNew": { argTypes: [], result: DYN },
  "fetch.abortTimeout": { argTypes: [DYN], result: DYN },
  "fetch.abortNow": { argTypes: [DYN], result: DYN },
  "fetch.abortAny": { argTypes: [DYN], result: DYN },
  "fetch.streamNew": { argTypes: [DYN], result: DYN },
  // Program-dependent iterable: typed arrays/bytes/string stay intact so
  // the native stream can pull lazily; checked-dynamic values are the
  // fallback. The libCall validator below checks the closed set.
  "fetch.streamFrom": { argTypes: [null], result: DYN },
  // The chunk/result record depends on ReadableStream<T>; validated below.
  "fetch.readerRead": { argTypes: [DYN], result: VOID },
  "island.eval": { argTypes: [STRING], result: STRING },
  "island.import": { argTypes: [STRING, STRING, STRING], result: JSVAL },
  "island.importDyn": { argTypes: [STRING], result: JSVAL },
  // Result is the cast's mapped PROMISE target (program-dependent) —
  // checked in the libCall case, like error.new.
  "island.castFail": { argTypes: [JSVAL, STRING], result: VOID },
  "json.parse": { argTypes: [STRING], result: DYN },
  "dyn.keySet": { argTypes: [DYN, STRING, DYN], result: VOID },
  "dyn.iterPack": { argTypes: [DYN, STRING], result: DYN },
  "dyn.arrLen": { argTypes: [DYN], result: F64 },
  "dyn.arrAt": { argTypes: [DYN, F64], result: DYN },
  "dyn.hasKey": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.toString": { argTypes: [DYN, STRING, STRING], result: STRING },
  "dyn.defineProps": { argTypes: [DYN, DYN], result: DYN },
  "dyn.typeof": { argTypes: [DYN], result: STRING },
  "timers.setTimeout": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: VOID },
  "timers.setInterval": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: F64 },
  "timers.clearInterval": { argTypes: [F64], result: VOID },
  "timers.setTimeoutHandle": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: F64 },
  "timers.clearTimeout": { argTypes: [F64], result: VOID },
  "timers.unref": { argTypes: [F64], result: F64 },
  "timers.ref": { argTypes: [F64], result: F64 },
  "timers.hasRef": { argTypes: [F64], result: BOOL },
  "timers.refresh": { argTypes: [F64], result: F64 },
  "timers.setImmediate": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: F64 },
  "timers.queueMicrotask": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  "timers.queueMicrotaskDyn": { argTypes: [DYN], result: VOID },
  "timers.clearImmediate": { argTypes: [F64], result: VOID },
  "process.nextTick": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  "process.uptime": { argTypes: [], result: F64 },
  "perf.now": { argTypes: [], result: F64 },
  "process.availableMemory": { argTypes: [], result: F64 },
  "process.constrainedMemory": { argTypes: [], result: F64 },
  "process.cpuUser": { argTypes: [], result: F64 },
  "process.cpuSystem": { argTypes: [], result: F64 },
  "process.cpuUserDiff": { argTypes: [F64], result: F64 },
  "process.cpuSystemDiff": { argTypes: [F64], result: F64 },
  "process.threadCpuUser": { argTypes: [], result: F64 },
  "process.threadCpuSystem": { argTypes: [], result: F64 },
  "process.threadCpuUserDiff": { argTypes: [F64], result: F64 },
  "process.threadCpuSystemDiff": { argTypes: [F64], result: F64 },
  "process.cpuPrevValidate": { argTypes: [F64, F64], result: VOID },
  "process.rusage": { argTypes: [F64], result: F64 },
  "process.activeResources": { argTypes: [], result: arrayOf(STRING) },
  "timers.immediateUnref": { argTypes: [F64], result: F64 },
  "timers.immediateRef": { argTypes: [F64], result: F64 },
  "timers.immediateHasRef": { argTypes: [F64], result: BOOL },
  "timers.clearNoop": { argTypes: [], result: VOID },
  // Signal listeners are zero-param (the ambient shape); exit/stdin
  // callbacks carry program-dependent one-param shapes — null slots, the
  // libCall case checks them (child.onExit precedent).
  "process.onSignal": { argTypes: [F64, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "process.offSignal": { argTypes: [F64, { kind: "func", params: [], ret: VOID }], result: VOID },
  "process.onExit": { argTypes: [null, BOOL], result: VOID },
  "process.offExit": { argTypes: [null], result: VOID },
  "stdin.onData": { argTypes: [null, BOOL], result: VOID },
  "stdin.onEnd": { argTypes: [{ kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "stdin.onError": { argTypes: [null, BOOL], result: VOID },
  "stdin.nextChunk": { argTypes: [], result: { kind: "promise", inner: BYTES_U8 } },
  "fs.readFileSync": { argTypes: [STRING, STRING], result: STRING },
  "fs.readFileSyncBuf": { argTypes: [STRING], result: BYTES_U8 },
  "fs.readFileSyncDyn": { argTypes: [STRING, DYN], result: DYN },
  "fs.writeFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.appendFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.existsSync": { argTypes: [STRING], result: BOOL },
  "fs.mkdirSync": { argTypes: [STRING], result: VOID },
  "fs.rmSync": { argTypes: [STRING], result: VOID },
  "fs.rmdirSync": { argTypes: [STRING], result: VOID },
  "fs.readdirSync": { argTypes: [STRING], result: arrayOf(STRING) },
  // Result is the call site's Dirent record array (VOID is the
  // structure-checked sentinel, the os.networkInterfaces pattern).
  "fs.readdirTypesSync": { argTypes: [STRING], result: VOID },
  "path.join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.normalize": { argTypes: [STRING], result: STRING },
  "path.dirname": { argTypes: [STRING], result: STRING },
  "path.basename": { argTypes: [STRING, STRING], result: STRING },
  "path.extname": { argTypes: [STRING], result: STRING },
  "path.isAbsolute": { argTypes: [STRING], result: BOOL },
  "path.relative": { argTypes: [STRING, STRING], result: STRING },
  "path.toNamespacedPath": { argTypes: [STRING], result: STRING },
  "path.win32Join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Normalize": { argTypes: [STRING], result: STRING },
  "path.win32Dirname": { argTypes: [STRING], result: STRING },
  "path.win32Basename": { argTypes: [STRING, STRING], result: STRING },
  "path.win32Extname": { argTypes: [STRING], result: STRING },
  "path.win32IsAbsolute": { argTypes: [STRING], result: BOOL },
  "path.win32Relative": { argTypes: [STRING, STRING], result: STRING },
  "path.win32ToNamespacedPath": { argTypes: [STRING], result: STRING },
  "os.homedir": { argTypes: [], result: STRING },
  "os.release": { argTypes: [], result: STRING },
  "os.type": { argTypes: [], result: STRING },
  "os.totalmem": { argTypes: [], result: F64 },
  "process.umask": { argTypes: [F64], result: F64 },
  "process.chdir": { argTypes: [STRING], result: VOID },
  "process.exiting": { argTypes: [], result: BOOL },
  "net.getAutoSelTimeout": { argTypes: [], result: F64 },
  "net.setAutoSelTimeout": { argTypes: [F64], result: VOID },
  "fs.realpathSync": { argTypes: [STRING], result: STRING },
  "os.userName": { argTypes: [], result: STRING },
  "os.userShell": { argTypes: [], result: STRING },
  "os.userHomedir": { argTypes: [], result: STRING },
  "os.tmpdir": { argTypes: [], result: STRING },
  // Result is the call site's Dict<NetworkInterfaceInfo[]> record (VOID is
  // the dgram.address sentinel — the libCall case checks the structure).
  "os.networkInterfaces": { argTypes: [], result: VOID },
  "math.maxArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.minArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.floor": { argTypes: [F64], result: F64 },
  "math.abs": { argTypes: [F64], result: F64 },
  "math.sin": { argTypes: [F64], result: F64 },
  "math.cos": { argTypes: [F64], result: F64 },
  "math.sqrt": { argTypes: [F64], result: F64 },
  "math.exp": { argTypes: [F64], result: F64 },
  "math.log": { argTypes: [F64], result: F64 },
  "math.pow": { argTypes: [F64, F64], result: F64 },
  "math.fround": { argTypes: [F64], result: F64 },
  "math.round": { argTypes: [F64], result: F64 },
  "math.trunc": { argTypes: [F64], result: F64 },
  "math.ceil": { argTypes: [F64], result: F64 },
  "math.min": { argTypes: [F64, F64], result: F64 },
  "math.max": { argTypes: [F64, F64], result: F64 },
  "math.random": { argTypes: [], result: F64 },
  "num.parseInt": { argTypes: [STRING, F64], result: F64 },
  "num.parseFloat": { argTypes: [STRING], result: F64 },
  "num.fromString": { argTypes: [STRING], result: F64 },
  "num.isNaN": { argTypes: [F64], result: BOOL },
  "str.encodeUriComponent": { argTypes: [STRING], result: STRING },
  // The base64 globals: the argument is a dyn value (WebIDL ToString
  // runs in the runtime); the zero-argument form always throws.
  "str.atob": { argTypes: [DYN], result: STRING },
  "str.btoa": { argTypes: [DYN], result: STRING },
  "str.b64Missing": { argTypes: [], result: STRING },
  "str.decodeUriComponent": { argTypes: [STRING], result: STRING },
  "str.encodeUri": { argTypes: [STRING], result: STRING },
  "regexp.escape": { argTypes: [STRING], result: STRING },
  "num.toExponential": { argTypes: [F64], result: STRING },
  "num.toFixed0": { argTypes: [F64], result: STRING },
  "num.toFixed": { argTypes: [F64, F64], result: STRING },
  "num.sameValue": { argTypes: [F64, F64], result: BOOL },
  "intl.numFormatEnUs": { argTypes: [F64], result: STRING },
  "sym.new": { argTypes: [STRING], result: SYMBOL_T },
  "sym.newAnon": { argTypes: [], result: SYMBOL_T },
  "sym.for": { argTypes: [STRING], result: SYMBOL_T },
  // Result is the interned `string | undefined` union — the libCall case
  // checks the arms (the spawnRes.error pattern).
  "sym.keyFor": { argTypes: [SYMBOL_T], result: VOID },
  "sym.desc": { argTypes: [SYMBOL_T], result: VOID },
  "sym.toString": { argTypes: [SYMBOL_T], result: STRING },
  "url.new": { argTypes: [STRING], result: URL_T },
  "url.protocol": { argTypes: [URL_T], result: STRING },
  "url.host": { argTypes: [URL_T], result: STRING },
  "url.hostname": { argTypes: [URL_T], result: STRING },
  "url.pathname": { argTypes: [URL_T], result: STRING },
  "url.href": { argTypes: [URL_T], result: STRING },
  "url.fileURLToPathUrl": { argTypes: [URL_T], result: STRING },
  "url.fileURLToPathStr": { argTypes: [STRING], result: STRING },
  "url.pathToFileURL": { argTypes: [STRING], result: URL_T },
  "url.pathToFileURLWin32": { argTypes: [STRING], result: URL_T },
  "sp.new": { argTypes: [], result: SEARCH_PARAMS_T },
  "sp.parse": { argTypes: [STRING], result: SEARCH_PARAMS_T },
  "sp.copy": { argTypes: [SEARCH_PARAMS_T], result: SEARCH_PARAMS_T },
  // The pairs argument is string[][] — checked structurally below (the
  // generic array-of slot has no named constant here).
  "sp.fromPairs": { argTypes: [null], result: SEARCH_PARAMS_T },
  "sp.with": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: SEARCH_PARAMS_T },
  "url.searchParams": { argTypes: [URL_T], result: SEARCH_PARAMS_T },
  "url.search": { argTypes: [URL_T], result: STRING },
  // Result is the interned `string | null` union — the libCall case
  // checks the arms (the spawnRes.signal pattern).
  "sp.get": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.getAll": { argTypes: [SEARCH_PARAMS_T, STRING], result: arrayOf(STRING) },
  "sp.append": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.set": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.delete": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.deleteValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.has": { argTypes: [SEARCH_PARAMS_T, STRING], result: BOOL },
  "sp.hasValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: BOOL },
  "sp.sort": { argTypes: [SEARCH_PARAMS_T], result: VOID },
  "sp.size": { argTypes: [SEARCH_PARAMS_T], result: F64 },
  "sp.toString": { argTypes: [SEARCH_PARAMS_T], result: STRING },
  "sp.keyAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  "sp.valAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  // node:querystring. qs.parse's result is the call site's ParsedUrlQuery
  // dictionary record (VOID is the networkInterfaces sentinel — the
  // libCall case checks the structure); qs.stringify's object argument
  // is a dyn value (the frontend dynFroms typed records).
  "qs.parse": { argTypes: [STRING, STRING, STRING, F64], result: VOID },
  "qs.stringify": { argTypes: [DYN, STRING, STRING], result: STRING },
  "qs.escape": { argTypes: [STRING], result: STRING },
  "qs.unescape": { argTypes: [STRING], result: STRING },
  "util.parseArgs": { argTypes: [DYN], result: DYN },
  "fs.statSync": { argTypes: [STRING], result: STATS_T },
  "fs.lstatSync": { argTypes: [STRING], result: STATS_T },
  "fs.openSync": { argTypes: [STRING, STRING], result: F64 },
  "fs.readSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeStrSync": { argTypes: [F64, STRING, F64, STRING], result: F64 },
  // fs.watch's callback func type is program-dependent (zero params, or
  // the eventType string) — the slot pins arity and the path/receiver.
  "fs.watch": { argTypes: [STRING], result: FSWATCHER_T },
  "fs.watchCb": { argTypes: [STRING, null], result: FSWATCHER_T },
  "watcher.close": { argTypes: [FSWATCHER_T], result: VOID },
  "crypto.x509Fingerprint": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509FingerprintStr": { argTypes: [STRING], result: STRING },
  "crypto.x509ValidFrom": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidFromStr": { argTypes: [STRING], result: STRING },
  "crypto.x509ValidTo": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidToStr": { argTypes: [STRING], result: STRING },
  "fs.closeSync": { argTypes: [F64], result: VOID },
  "stats.isFile": { argTypes: [STATS_T], result: BOOL },
  "stats.isDirectory": { argTypes: [STATS_T], result: BOOL },
  "stats.isSymbolicLink": { argTypes: [STATS_T], result: BOOL },
  "stats.size": { argTypes: [STATS_T], result: F64 },
  "stats.blocks": { argTypes: [STATS_T], result: F64 },
  "stats.nlink": { argTypes: [STATS_T], result: F64 },
  "stats.atimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.mtimeMs": { argTypes: [STATS_T], result: F64 },
  // The wider sync fs slice (unlink/chmod/chown/copyfile and the
  // mode-carrying write/mkdir forms).
  "fs.unlinkSync": { argTypes: [STRING], result: VOID },
  "fs.chmodSync": { argTypes: [STRING, F64], result: VOID },
  "fs.chownSync": { argTypes: [STRING, F64, F64], result: VOID },
  "fs.copyFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.renameSync": { argTypes: [STRING, STRING], result: VOID },
  // Callback type is program-dependent (zero params or Error | null).
  "fs.renameCb": { argTypes: [STRING, STRING, null], result: VOID },
  "fs.writeFileModeSync": { argTypes: [STRING, STRING, F64], result: VOID },
  "fs.mkdirModeSync": { argTypes: [STRING, F64], result: VOID },
  "fs.mkdirRecursiveModeSync": { argTypes: [STRING, F64], result: VOID },
  // Atomics.wait over an Int32Array — the synchronous-sleep idiom.
  "atomics.wait": { argTypes: [bytesOf("i32"), F64, F64, F64], result: STRING },
  "cp.spawnSync": { argTypes: [STRING, arrayOf(STRING)], result: SPAWNRES_T },
  // spawnSync's options form: timeout, killSignal name ("" = SIGTERM),
  // and the three stdio modes.
  "cp.spawnSyncOpts": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, F64, F64, F64],
    result: SPAWNRES_T,
  },
  "cp.spawnSyncStdioStr": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, STRING],
    result: SPAWNRES_T,
  },
  // node:net (scr_net.c). Listener slots are program-dependent closures —
  // null slots, checked in the libCall case (the child.onExit precedent);
  // the zero-param callbacks pin the exact func type here. The trailing
  // BOOL on registrations is the once flag.
  "net.createServer": { argTypes: [], result: NETSERVER_T },
  "net.createServerCb": { argTypes: [null], result: NETSERVER_T },
  "net.listen": { argTypes: [NETSERVER_T, F64], result: VOID },
  "net.listenCb": { argTypes: [NETSERVER_T, F64, { kind: "func", params: [], ret: VOID }], result: VOID },
  "net.listenOpts": { argTypes: [NETSERVER_T, F64, STRING, BOOL], result: VOID },
  // The callback slot is a zero-param void closure OR its
  // `(() => void) | undefined` optional-binding union (checked specially).
  "net.listenOptsCb": { argTypes: [NETSERVER_T, F64, STRING, BOOL, null], result: VOID },
  "net.serverPort": { argTypes: [NETSERVER_T], result: F64 },
  // net.serverAddress's record result is shape-checked in the libCall case
  // (the dgram.address sentinel pattern).
  "net.serverAddress": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverClose": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverCloseCb": { argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }], result: VOID },
  "net.serverOnError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.serverOnClose": { argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "net.serverOnConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.serverOnSecureConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.connect": { argTypes: [F64, STRING], result: NETSOCKET_T },
  "net.connectAttempt": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  "net.connectOptsChk": { argTypes: [DYN, STRING], result: VOID },
  "net.connectCb": { argTypes: [F64, STRING, { kind: "func", params: [], ret: VOID }], result: NETSOCKET_T },
  // The lookup's exact func shape is program data (its answer callback's
  // union/record types) — checked specially in the libCall case.
  "net.connectLookup": { argTypes: [F64, STRING, null], result: NETSOCKET_T },
  "net.sockWrite": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "net.sockWriteBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  "net.sockEnd": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockEndStr": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "net.sockEndBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  "net.sockWriteDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockEndDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockDestroy": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockPipe": { argTypes: [NETSOCKET_T, NETSOCKET_T], result: VOID },
  "net.sockPipeRes": { argTypes: [NETSOCKET_T, HTTPRES_T], result: VOID },
  "net.sockOnData": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnEnd": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "net.sockOnClose": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "net.sockOnError": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnConnect": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  // node:dgram + node:dns (scr_dgram.c). The message/error listeners and
  // dns.lookup's callback are program-dependent closures (null slots,
  // checked in the libCall case); dgram.address's record result is
  // program-dependent too (VOID here is the envGet sentinel — the libCall
  // case checks the {address, family, port} shape).
  "dgram.createSocket": { argTypes: [BOOL], result: DGRAMSOCK_T },
  "dgram.bind": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.bindCb": { argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }], result: VOID },
  "dgram.connect": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.connectCb": { argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }], result: VOID },
  "dgram.sendStr": { argTypes: [DGRAMSOCK_T, STRING, F64, STRING], result: VOID },
  "dgram.sendBytes": { argTypes: [DGRAMSOCK_T, BYTES_U8, F64, STRING], result: VOID },
  "dgram.sendChk": { argTypes: [DGRAMSOCK_T, DYN, DYN, DYN, DYN, DYN, STRING], result: VOID },
  "dgram.address": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.close": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.closeCb": { argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }], result: VOID },
  "dgram.unref": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.ref": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.onMessage": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onError": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onListening": { argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "dgram.onClose": { argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "dgram.onConnect": { argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "dns.lookup": { argTypes: [STRING, F64, null], result: VOID },
  // node:test (scr_test.c). Bodies are program-dependent closures (0 or
  // 1 testCtx param, void or Promise<void> result — the spoke pinned the
  // shape): null slots. sub's result is the settled Promise<void> the
  // await consumes.
  "test.register": { argTypes: [STRING, F64, STRING, null, F64, STRING], result: VOID },
  "test.registerEmpty": { argTypes: [STRING, F64, STRING, F64, STRING], result: VOID },
  "test.suite": { argTypes: [STRING, F64, STRING, { kind: "func", params: [], ret: VOID }, STRING], result: VOID },
  "test.hook": { argTypes: [F64, null, F64], result: VOID },
  "test.sub": { argTypes: [TESTCTX_T, STRING, F64, STRING, null, F64, STRING], result: { kind: "promise", inner: VOID } },
  "test.subEmpty": { argTypes: [TESTCTX_T, STRING, F64, STRING, STRING], result: VOID },
  "test.ctxSkip": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxTodo": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxDiagnostic": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxName": { argTypes: [TESTCTX_T], result: STRING },
  // node:http (scr_http.c over scr_net.c). The handler and the data
  // listeners are program-dependent closures (null slots, checked in the
  // libCall case); reqHeader's result is the interned string|undefined
  // union, checked like process.envGet.
  "http.createServer": { argTypes: [null], result: NETSERVER_T },
  "http.createServerEmpty": { argTypes: [], result: NETSERVER_T },
  "http.serverJoinDupHeaders": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverTimeoutGet": { argTypes: [NETSERVER_T, F64], result: F64 },
  "http.serverTimeoutSet": { argTypes: [NETSERVER_T, F64, F64], result: VOID },
  "http.serverTimeoutOptionSet": { argTypes: [NETSERVER_T, F64, DYN], result: VOID },
  "net.serverOnListening": { argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.resStatusGet": { argTypes: [HTTPRES_T], result: F64 },
  "http.resStatusSet": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resStatusMsgGet": { argTypes: [HTTPRES_T], result: STRING },
  "http.resStatusMsgSet": { argTypes: [HTTPRES_T, STRING], result: VOID },
  // resGetHeader answers the interned `string | undefined` union — the
  // reqHeader/envGet sentinel pattern (VOID here, checked specially).
  "http.resGetHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resHasHeader": { argTypes: [HTTPRES_T, STRING], result: BOOL },
  "http.resRemoveHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resOnFinish": { argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }], result: VOID },
  "http.reqUrl": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqMethod": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHeader": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqOnData": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  "http.reqOnEnd": { argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.resSetHeader": { argTypes: [HTTPRES_T, STRING, STRING], result: VOID },
  "http.resWriteHead": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resWriteHeadN": { argTypes: [HTTPRES_T, F64, arrayOf(STRING), arrayOf(STRING)], result: VOID },
  "http.resWrite": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resWriteBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: VOID },
  "http.resEnd": { argTypes: [HTTPRES_T], result: VOID },
  "http.resEndStr": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resEndBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: VOID },
  "http.resWriteDyn": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resEndDyn": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resHeadersSent": { argTypes: [HTTPRES_T], result: BOOL },
  // The member follow-ups: reqStatusCode's `number | undefined` and
  // sockRemoteAddress's `string | undefined` results are shape-checked in
  // the special cases below (like reqHeader/columns).
  "http.reqStatusCode": { argTypes: [HTTPREQ_T], result: VOID },
  // reqStatusMessage's `string | undefined` is program-interned like
  // reqHeader's (the VOID here is the envGet sentinel).
  "http.reqStatusMessage": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqRawHeaders": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "http.reqHeaderPairs": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "net.sockDestroyed": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockWritable": { argTypes: [NETSOCKET_T], result: BOOL },
  // The 'upgrade' registrations: the callback shapes are program-typed
  // ((req, socket, head) and shorter prefixes — the libCall case checks).
  "http.serverOnUpgrade": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.serverOnConnect": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.clientOnUpgrade": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.reqSocket": { argTypes: [HTTPREQ_T], result: NETSOCKET_T },
  "http.reqPipeRes": { argTypes: [HTTPREQ_T, HTTPRES_T], result: VOID },
  "http.reqPipeClient": { argTypes: [HTTPREQ_T, HTTPCLIENTREQ_T], result: VOID },
  "http.reqPipeSock": { argTypes: [HTTPREQ_T, NETSOCKET_T], result: VOID },
  "http.reqResume": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqDestroy": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqOnError": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  "http.reqOnClose": { argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.reqOnAborted": { argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.reqHttpVersion": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHttpVersionMajor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqHttpVersionMinor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqAborted": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.reqComplete": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.resDestroy": { argTypes: [HTTPRES_T], result: VOID },
  "http.resOnClose": { argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.resWriteHeadPairs": { argTypes: [HTTPRES_T, F64, arrayOf(STRING)], result: VOID },
  "http.resWriteHeadDyn": { argTypes: [HTTPRES_T, F64, DYN], result: VOID },
  "net.sockSetTimeout": { argTypes: [NETSOCKET_T, F64], result: VOID },
  "net.sockSetEncoding": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "http.reqSetEncoding": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "net.sockOnTimeout": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "net.sockRemoteAddress": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockEncrypted": { argTypes: [NETSOCKET_T], result: VOID },
  // node:http, the client slice. The response callback shapes are
  // program-dependent (checked below); header pairs arrive flat.
  "http.request": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL], result: HTTPCLIENTREQ_T },
  "http.requestCb": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, null], result: HTTPCLIENTREQ_T },
  "http.agentNew": { argTypes: [BOOL, BOOL, F64, F64, F64, F64, F64], result: DYN },
  "http.requestAgent": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN], result: HTTPCLIENTREQ_T },
  "http.requestAgentCb": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN, null], result: HTTPCLIENTREQ_T },
  "http.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "http.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  "net.sockOnReadable": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  // sockRead's result is the interned `Buffer | null` union — checked
  // specially below (the reqHeader/envGet pattern; VOID here is a
  // placeholder the special case overrides).
  "net.sockRead": { argTypes: [NETSOCKET_T, F64], result: VOID },
  "net.sockUnshift": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  "net.sockPause": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  "net.sockResume": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  "net.sockSetNoDelay": { argTypes: [NETSOCKET_T, BOOL], result: NETSOCKET_T },
  "net.sockDestroySoon": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockBytesWritten": { argTypes: [NETSOCKET_T], result: F64 },
  "net.sockReadable": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockOnFinish": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }], result: VOID },
  "net.serverEmitConnection": { argTypes: [NETSERVER_T, NETSOCKET_T], result: VOID },
  // tls/https: cert/key/ca PEM arguments are strings OR Buffers (null =
  // both accepted; the emitter passes data+len either way).
  "tls.createServer": { argTypes: [null, null], result: NETSERVER_T },
  "tls.createServerCb": { argTypes: [null, null, null], result: NETSERVER_T },
  // The runtime options records (divergence 66's stance): a dyn options
  // value whose members read at runtime; pemDyn extracts a runtime-valued
  // cert/key member (arg 1 is the precomposed fence label).
  "tls.pemDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "tls.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "tls.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  "https.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "https.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  "http2.createSecureServerReq": { argTypes: [null, null, null], result: NETSERVER_T },
  "http2.createSecureServerH2Req": { argTypes: [null, null, null], result: NETSERVER_T },
  "http2.createSecureServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "http2.createSecureServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  // tls.connect(port, host, opts[, cb]) — port -1 / host "" read the
  // options record; the callback fires post-handshake (secureConnect).
  "tls.connect": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  "tls.connectCb": { argTypes: [F64, STRING, DYN, null], result: NETSOCKET_T },
  // The TLSSocket member surface (authError's `string | null` union is
  // shape-checked in the special cases below — the reqHeader pattern).
  "tls.sockAuthorized": { argTypes: [NETSOCKET_T], result: BOOL },
  "tls.sockAuthError": { argTypes: [NETSOCKET_T], result: VOID },
  "tls.sockOnSecureConnect": { argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "tls.sockOnSession": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  // createSecureContext({ cert, key }) mints the opaque SNI-answer handle.
  "tls.createSecureContext": { argTypes: [null, null], result: SECURECTX_T },
  "tls.createSecureContextDyn": { argTypes: [DYN], result: SECURECTX_T },
  "tls.caCertsChk": { argTypes: [DYN, STRING], result: VOID },
  // The CA-store introspection unit (scr_tls_ca.c): per-type cached PEM
  // string arrays and the default-set replacement.
  "tlsca.get": { argTypes: [STRING], result: arrayOf(STRING) },
  "tlsca.root": { argTypes: [], result: arrayOf(STRING) },
  "tlsca.set": { argTypes: [arrayOf(STRING)], result: VOID },
  "https.createServer": { argTypes: [null, null, null], result: NETSERVER_T },
  // http2's allowHTTP1 compatibility server (divergence 57): cert/key
  // like tls.createServer; the 'request' handler arrives separately via
  // http.serverOnRequest (shape checked in the libCall case, like
  // http.createServer's). serverOnSessionError's callback is any void
  // closure — it is released unread (no h2 session ever fires it).
  "http2.createSecureServer": { argTypes: [null, null], result: NETSERVER_T },
  // The SNI-callback form: arg 2 is the JS SNICallback closure — a
  // `(servername, cb) => void` func, or its `| undefined` union from the
  // conditional-spread spelling (the libCall case checks the shape).
  "http2.createSecureServerSni": { argTypes: [null, null, null], result: NETSERVER_T },
  // The ALPN=h2 server (createSecureServer without allowHTTP1): the real
  // h2 session machinery behind the TLS handshake.
  "http2.createSecureServerH2": { argTypes: [null, null], result: NETSERVER_T },
  "http.serverOnRequest": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.serverOnSessionError": { argTypes: [NETSERVER_T, null], result: VOID },
  "http2.streamNoop": { argTypes: [], result: VOID },
  "http2.streamUndefCall": { argTypes: [STRING], result: VOID },
  // The REAL h2c surface (scr_http2.c). Callback slots are null (the
  // emitter picks the thunk); pairs slots are string arrays; the
  // endStream tri-state and event flags ride as f64.
  "http2.createServer": { argTypes: [], result: NETSERVER_T },
  "http2.createServerReq": { argTypes: [null], result: NETSERVER_T },
  "http2.serverOnStream": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.serverOnSession": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  // connect(authority, reject, ca[, cb]): the TLS client knobs an https
  // authority reads (inert on http ones, exactly Node); ca is a PEM
  // string/Buffer ("" = the system anchors).
  "http2.connect": { argTypes: [STRING, BOOL, null], result: HTTP2SESSION_T },
  "http2.connectCb": { argTypes: [STRING, BOOL, null, null], result: HTTP2SESSION_T },
  "http2.sessionRequest": { argTypes: [HTTP2SESSION_T, arrayOf(STRING), F64], result: HTTP2STREAM_T },
  "http2.sessionClose": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionCloseCb": { argTypes: [HTTP2SESSION_T, null], result: VOID },
  "http2.sessionDestroy": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionOnClose": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnError": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnConnect": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnStream": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnGoaway": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionClosed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionDestroyed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionEncrypted": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionType": { argTypes: [HTTP2SESSION_T], result: F64 },
  "http2.sessionAlpn": { argTypes: [HTTP2SESSION_T], result: STRING },
  "http2.sessionSocket": { argTypes: [HTTP2SESSION_T], result: NETSOCKET_T },
  "http2.streamRespond": { argTypes: [HTTP2STREAM_T, arrayOf(STRING), BOOL], result: VOID },
  "http2.streamWrite": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamWriteBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamEnd": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamEndStr": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamEndBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamClose": { argTypes: [HTTP2STREAM_T, F64], result: VOID },
  "http2.streamCloseCb": { argTypes: [HTTP2STREAM_T, F64, null], result: VOID },
  "http2.streamDestroy": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.sessionSettings0": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionSettings": { argTypes: [HTTP2SESSION_T, DYN], result: VOID },
  "http2.sessionSettingsDynCb": { argTypes: [HTTP2SESSION_T, DYN, DYN], result: VOID },
  "http2.sessionSettingsCb0": { argTypes: [HTTP2SESSION_T, DYN, { kind: "func", params: [], ret: VOID }], result: VOID },
  "http2.sessionOnSettingsDyn": { argTypes: [HTTP2SESSION_T, DYN, BOOL, BOOL], result: VOID },
  "http2.sessionOnSettings0": { argTypes: [HTTP2SESSION_T, { kind: "func", params: [], ret: VOID }, BOOL, BOOL], result: VOID },
  "http2.sessionSettingsGet": { argTypes: [HTTP2SESSION_T, BOOL], result: DYN },
  "http2.sessionPendingSettingsAck": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.getDefaultSettings": { argTypes: [], result: DYN },
  "http2.streamSetEncoding": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamSetEncodingRet": { argTypes: [HTTP2STREAM_T, STRING], result: HTTP2STREAM_T },
  "http2.streamResume": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamPause": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamOnData": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnEnd": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnClose": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnAborted": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnError": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnResponse": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamId": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamRstCode": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamDestroyed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamClosed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamAborted": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamPending": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamSession": { argTypes: [HTTP2STREAM_T], result: HTTP2SESSION_T },
  // The createConnection forms: arg 0 is the dialer closure (() =>
  // Socket — the libCall case checks), then path/method/timeout/headers/
  // autoEnd like http.request.
  "http.requestConn": { argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL], result: HTTPCLIENTREQ_T },
  "http.requestConnCb": { argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL, null], result: HTTPCLIENTREQ_T },
  "https.request": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestCb": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null], result: HTTPCLIENTREQ_T },
  "https.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "https.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestAgent": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN], result: HTTPCLIENTREQ_T },
  "https.requestAgentCb": { argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN, null], result: HTTPCLIENTREQ_T },
  // The requestFn binding's runtime-secure rows: https.request's shape
  // with the leading `secure` bool.
  "https.requestFn": { argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestFnCb": { argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null], result: HTTPCLIENTREQ_T },
  "http.clientWrite": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientWriteBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: VOID },
  "http.clientEnd": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientEndStr": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientEndBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: VOID },
  "http.clientWriteDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  "http.clientEndDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  "http.clientDestroy": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientDestroyed": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientOnResponse": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnError": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnTimeout": { argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "http.clientOnClose": { argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "cp.execSync": {
    argTypes: [STRING, arrayOf(STRING), BOOL, STRING, BOOL, STRING, BOOL, arrayOf(STRING), F64, F64, F64],
    result: STRING,
  },
  "cp.execCapture": {
    argTypes: [STRING, arrayOf(STRING), STRING, BOOL, arrayOf(STRING), F64],
    result: SPAWNRES_T,
  },
  "cp.spawn": { argTypes: [STRING, arrayOf(STRING)], result: CHILD_T },
  // spawn's options form: per-slot stdio modes (0 ignore / 1 inherit /
  // 2 fd) with the out/err fds for mode 2, detached, env replacement
  // pairs, cwd ("" = inherit).
  "cp.spawnOpts": {
    argTypes: [STRING, arrayOf(STRING), F64, F64, F64, F64, F64, BOOL, BOOL, arrayOf(STRING), STRING],
    result: CHILD_T,
  },
  // The callback's func type is program-dependent (zero params, or the
  // `number | null` union / the %Error class) — the libCall case checks
  // the shape; the slot here only pins arity and the child receiver.
  "child.onExit": { argTypes: [CHILD_T, null], result: VOID },
  "child.onError": { argTypes: [CHILD_T, null], result: VOID },
  // Like process.envGet, spawnRes.status's result type is program-dependent
  // (the interned `number | null` union) — the libCall case checks the arms.
  "spawnRes.status": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.error's result is the interned `Error | undefined` union —
  // the libCall case checks the arms, the spawnRes.status pattern.
  "spawnRes.error": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.signal's result is the interned `string | null` union —
  // same pattern.
  "spawnRes.signal": { argTypes: [SPAWNRES_T], result: VOID },
  // The ChildProcess lifecycle members: pid/exitCode are program-dependent
  // unions (`number | undefined` / `number | null` — the libCall case
  // checks the arms, the spawnRes.status pattern).
  "child.pid": { argTypes: [CHILD_T], result: VOID },
  "child.exitCode": { argTypes: [CHILD_T], result: VOID },
  // The close-override pair: the bound close's result func type and the
  // override's func argument are program-dependent (the callback union's
  // tags) — the slots pin the server receiver; the libCall case checks
  // the bound value's shape.
  "net.serverCloseBind": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverSetCloseOverride": { argTypes: [NETSERVER_T, null], result: VOID },
  // The piped-output stream reads: `Readable | null` unions (the libCall
  // case checks the arms — the child.pid pattern with a ref arm).
  "child.stdout": { argTypes: [CHILD_T], result: VOID },
  "child.stderr": { argTypes: [CHILD_T], result: VOID },
  // Listener registrations: callback func shapes are program-dependent
  // (zero-param / Buffer / Buffer-armed union) — the slots pin arity,
  // the stream receiver, and the once-flag.
  "stream.onData": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.onEnd": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "procStream.write": { argTypes: [PROCSTREAM_T, STRING], result: BOOL },
  "child.killed": { argTypes: [CHILD_T], result: BOOL },
  "child.kill": { argTypes: [CHILD_T, STRING], result: BOOL },
  "child.killNum": { argTypes: [CHILD_T, F64], result: BOOL },
  "child.unref": { argTypes: [CHILD_T], result: VOID },
  "spawnRes.stdout": { argTypes: [SPAWNRES_T], result: STRING },
  "spawnRes.stderr": { argTypes: [SPAWNRES_T], result: STRING },
  "crypto.randomUUID": { argTypes: [], result: STRING },
  "crypto.randomBytesToString": { argTypes: [F64, STRING], result: STRING },
  "crypto.randomBytes": { argTypes: [F64], result: BYTES_U8 },
  "crypto.hashDigestStr": { argTypes: [STRING, STRING, STRING], result: STRING },
  "crypto.hashDigestBytes": { argTypes: [STRING, BYTES_U8, STRING], result: STRING },
  // The Buffer statics and the fs/zlib Buffer forms: fixed always-u8
  // signatures (Buffer IS a Uint8Array — one bytes kind).
  "buffer.fromStr": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.concat": { argTypes: [arrayOf(BYTES_U8)], result: BYTES_U8 },
  "buffer.byteLenStr": { argTypes: [STRING, STRING], result: F64 },
  "buffer.isEncoding": { argTypes: [STRING], result: BOOL },
  "buffer.concatLen": { argTypes: [arrayOf(BYTES_U8), F64], result: BYTES_U8 },
  // The checked-dynamic compare/equals validators (Node's argument
  // ladders over dyn-boxed invalid-input probes).
  "buffer.compareChk": { argTypes: [DYN, DYN], result: F64 },
  "bytes.equalsChk": { argTypes: [BYTES_U8, DYN], result: BOOL },
  "bytes.compareChk": { argTypes: [BYTES_U8, DYN, DYN, DYN, DYN, DYN], result: F64 },
  "buffer.newStringFail": { argTypes: [DYN], result: BYTES_U8 },
  "fs.toUnixTimestamp": { argTypes: [DYN], result: F64 },
  "fs.existsChk": { argTypes: [DYN, DYN], result: DYN },
  "fs.mkdtempChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.mkdtempSyncChk": { argTypes: [DYN, DYN, STRING], result: STRING },
  "fs.readFileChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.opendirChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.watchFileChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.lchmodChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.lchmodSyncChk": { argTypes: [DYN, DYN], result: DYN },
  "fsp.lchmodChk": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fs.readChk": { argTypes: [DYN, DYN, DYN, DYN, DYN, STRING], result: VOID },
  "fs.streamOptsChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "error.argTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  "error.propTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  "emitter.setMaxChk": { argTypes: [null, DYN], result: VOID },
  "emitter.setDefaultMaxChk": { argTypes: [DYN, STRING], result: VOID },
  "fs.readFileSyncBytes": { argTypes: [STRING], result: BYTES_U8 },
  "fs.writeFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  "fsp.readFileBytes": { argTypes: [STRING], result: { kind: "promise", inner: BYTES_U8 } },
  "zlib.deflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.inflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "process.stdoutWriteBytes": { argTypes: [BYTES_U8, STRING], result: BOOL },
  "process.stderrWriteBytes": { argTypes: [BYTES_U8, STRING], result: BOOL },
  // Completion callback is program-dependent: zero params, checked-dynamic,
  // or an optional Error | null slot (same success shape as fs.rename).
  "process.stdoutWriteBytesCb": { argTypes: [BYTES_U8, STRING, null], result: BOOL },
  "process.stderrWriteBytesCb": { argTypes: [BYTES_U8, STRING, null], result: BOOL },
  "fsp.readFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: STRING } },
  "fsp.writeFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.writeFileMode": { argTypes: [STRING, STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.mkdir": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursive": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursiveMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.unlink": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.chmod": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.rename": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.readdir": { argTypes: [STRING], result: { kind: "promise", inner: arrayOf(STRING) } },
  "fsp.rm": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.stat": { argTypes: [STRING], result: { kind: "promise", inner: STATS_T } },
  "fsp.open": { argTypes: [STRING, STRING, F64], result: { kind: "promise", inner: FILEHANDLE_T } },
  "fileHandle.fd": { argTypes: [FILEHANDLE_T], result: F64 },
  "fileHandle.close": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  // read/write carry call-site result record shapes; the validator checks
  // those below, so promise<void> is only a table sentinel.
  "fileHandle.read": { argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL], result: { kind: "promise", inner: VOID } },
  "fileHandle.writeBytes": { argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL], result: { kind: "promise", inner: VOID } },
  "fileHandle.writeStr": { argTypes: [FILEHANDLE_T, STRING, F64, STRING], result: { kind: "promise", inner: VOID } },
  "fileHandle.readFile": { argTypes: [FILEHANDLE_T, STRING], result: { kind: "promise", inner: STRING } },
  "fileHandle.readFileBytes": { argTypes: [FILEHANDLE_T, STRING], result: { kind: "promise", inner: BYTES_U8 } },
  "fileHandle.writeFile": { argTypes: [FILEHANDLE_T, STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fileHandle.writeFileBytes": { argTypes: [FILEHANDLE_T, BYTES_U8, STRING], result: { kind: "promise", inner: VOID } },
  "fileHandle.stat": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: STATS_T } },
  "process.argv": { argTypes: [], result: arrayOf(STRING) },
  "process.platform": { argTypes: [], result: STRING },
  // The one libCall whose result type is program-dependent (union ids are
  // per-module): the `result` here is a placeholder — the libCall case
  // checks the union's ARMS ([string, undefinedT] in canonical order)
  // against the module's registry instead.
  "process.envGet": { argTypes: [STRING], result: VOID },
  "process.envSet": { argTypes: [STRING, STRING], result: VOID },
  "process.envUnset": { argTypes: [STRING], result: VOID },
  "process.envPairs": { argTypes: [], result: arrayOf(STRING) },
  "process.exit": { argTypes: [F64], result: VOID },
  "process.cwd": { argTypes: [], result: STRING },
  "process.pid": { argTypes: [], result: F64 },
  "dyn.this": { argTypes: [], result: DYN },
  "process.getuid": { argTypes: [], result: F64 },
  "process.getgid": { argTypes: [], result: F64 },
  "process.execPath": { argTypes: [], result: STRING },
  "process.arch": { argTypes: [], result: STRING },
  "process.versionsNode": { argTypes: [], result: STRING },
  "process.versionsOpenssl": { argTypes: [], result: STRING },
  "process.kill": { argTypes: [F64, STRING], result: BOOL },
  "process.killNum": { argTypes: [F64, F64], result: BOOL },
  "process.stdoutWrite": { argTypes: [STRING], result: BOOL },
  "process.stderrWrite": { argTypes: [STRING], result: BOOL },
  // error.new's result and the receiver slots are builtin-error classes —
  // program-dependent object types, checked in the libCall case.
  "error.new": { argTypes: [STRING], result: VOID },
  "error.nodeThrow": { argTypes: [F64, STRING, STRING], result: VOID },
  "dyn.toStringCoerce": { argTypes: [DYN], result: STRING },
  // Always throws; the result is the READ's declared type (a typed dummy
  // the unwind abandons) — the libCall case skips the result check.
  "global.undefRead": { argTypes: [STRING], result: VOID },
  // `X.name` through a class value: the arg is a program-dependent
  // classval (a null slot; the libCall case checks the kind).
  "class.name": { argTypes: [null], result: STRING },
  "error.ctor": { argTypes: [null, STRING], result: VOID },
  "error.toString": { argTypes: [null], result: STRING },
  // Receiver (any error-hierarchy object) and the program-dependent
  // `string | undefined` result are checked in the libCall case.
  "error.code": { argTypes: [null], result: VOID },
  // DOMException: construction takes the two dyn args (WebIDL's
  // resolution runs in the runtime); the %DOMException result is a
  // program-dependent object type, checked in the libCall case. The
  // read surface takes the %DOMException receiver (a null slot — the
  // libCall case checks the class name).
  "error.newDom": { argTypes: [DYN, DYN], result: VOID },
  "error.domCode": { argTypes: [null], result: F64 },
  "error.domHasCause": { argTypes: [null], result: BOOL },
  "error.domCause": { argTypes: [null], result: DYN },
  "error.domClone": { argTypes: [null, DYN], result: VOID },
  "dyn.errInstanceof": { argTypes: [DYN, F64], result: BOOL },
  "dyn.objKeys": { argTypes: [DYN], result: DYN },
  "dyn.hasOwn": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.assign": { argTypes: [DYN, DYN], result: DYN },
  "dyn.packPush": { argTypes: [DYN, DYN], result: VOID },
  "dyn.packPushSpread": { argTypes: [DYN, DYN, STRING], result: VOID },
  "dyn.packPushSpreadIter": { argTypes: [DYN, DYN], result: VOID },
  "dyn.assignAll": { argTypes: [DYN, DYN], result: DYN },
  "dyn.objCreateNullProto": { argTypes: [], result: DYN },
  "dyn.objValues": { argTypes: [DYN], result: DYN },
  "dyn.objEntries": { argTypes: [DYN], result: DYN },
  "dyn.structuredClone": { argTypes: [DYN, DYN], result: DYN },
  "dyn.cloneMissing": { argTypes: [], result: DYN },
  "dyn.cloneTransferFail": { argTypes: [], result: DYN },
  "regex.new": { argTypes: [STRING, STRING], result: REGEX },
  // node:events EventEmitter: receivers are emitter-hierarchy objects and
  // the chaining forms (on/off/removeAll/setMax) return the receiver's
  // own class — program-dependent object types, checked in the libCall
  // case. emitter.emit is the one VARIADIC libCall: args beyond
  // (recv, name) are the event's frontend-unified tuple, any borrowable
  // kind — the count check admits a longer list for it alone.
  "emitter.new": { argTypes: [], result: VOID },
  "emitter.ctor": { argTypes: [null], result: VOID },
  "emitter.on": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  "emitter.off": { argTypes: [null, STRING, null], result: VOID },
  // The dyn-adapted registration family (JS-lane checked-dynamic
  // listeners): checkListener has NO receiver (it validates the listener
  // argument alone); onDyn carries (recv, name, cb dyn, adapter func,
  // once, prepend), offDyn (recv, name, cb dyn).
  "emitter.checkListener": { argTypes: [DYN], result: VOID },
  "emitter.onDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.offDyn": { argTypes: [null, STRING, DYN], result: VOID },
  "emitter.removeAll": { argTypes: [null, STRING, BOOL], result: VOID },
  "emitter.emit": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitError": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.count": { argTypes: [null, STRING], result: F64 },
  "emitter.countFn": { argTypes: [null, STRING, null], result: F64 },
  "emitter.names": { argTypes: [null], result: VOID },
  "emitter.listeners": { argTypes: [null, STRING], result: VOID },
  "emitter.onData": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  "emitter.onDataDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.emitData": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.setMax": { argTypes: [null, F64], result: VOID },
  "emitter.getMax": { argTypes: [null], result: F64 },
  "emitter.setDefaultMax": { argTypes: [F64], result: VOID },
  "emitter.getDefaultMax": { argTypes: [], result: F64 },
  // node:stream: receivers are stream-hierarchy objects and several
  // results are program-dependent (the receiver's class, unions) — the
  // libCall case owns those checks. The constructors and a few methods
  // are VARIADIC (trailing option callbacks / the optional chunk+cb tail):
  // argTypes here is the fixed prefix, VARIADIC_LIB_FNS admits the rest.
  "readable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "writable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "duplex.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "transform.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "passthrough.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  // The subclass-initialization twins: the borrowed receiver leads, then
  // the .new tail (variadic callbacks likewise).
  // The dyn-options twins: newDyn takes the record, initDyn the borrowed
  // receiver + record + fallback flags (trailing wrapper closures ride
  // the variadic tail like the static forms).
  "stream.setRead": { argTypes: [null, null], result: VOID },
  "stream.setWrite": { argTypes: [null, null], result: VOID },
  "stream.setFinal": { argTypes: [null, null], result: VOID },
  "stream.setDestroy": { argTypes: [null, null], result: VOID },
  "stream.setTransform": { argTypes: [null, null], result: VOID },
  "stream.setFlush": { argTypes: [null, null], result: VOID },
  "stream.finished": { argTypes: [null, null], result: VOID },
  "stream.finishedDyn": { argTypes: [null, DYN], result: VOID },
  "stream.pipeline": { argTypes: [F64], result: VOID },
  "stream.pipelineDyn": { argTypes: [F64], result: VOID },
  "sp.finished": { argTypes: [null], result: { kind: "promise", inner: VOID } },
  "sp.pipeline": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "sc.text": { argTypes: [null], result: { kind: "promise", inner: STRING } },
  "sc.json": { argTypes: [null], result: { kind: "promise", inner: DYN } },
  "sc.buffer": { argTypes: [null], result: { kind: "promise", inner: BYTES_U8 } },
  "readable.newDyn": { argTypes: [DYN], result: VOID },
  "writable.newDyn": { argTypes: [DYN], result: VOID },
  "duplex.newDyn": { argTypes: [DYN], result: VOID },
  "transform.newDyn": { argTypes: [DYN], result: VOID },
  "passthrough.newDyn": { argTypes: [DYN], result: VOID },
  "readable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "writable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "duplex.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "transform.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "passthrough.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "readable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "writable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "duplex.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "transform.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "passthrough.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "readable.push": { argTypes: [null, BYTES_U8], result: BOOL },
  "readable.pushStr": { argTypes: [null, STRING], result: BOOL },
  "readable.pushNull": { argTypes: [null], result: BOOL },
  "readable.pushU": { argTypes: [null, null], result: BOOL },
  "readable.pushDyn": { argTypes: [null, DYN], result: BOOL },
  "readable.unshift": { argTypes: [null, BYTES_U8], result: VOID },
  "readable.unshiftStr": { argTypes: [null, STRING], result: VOID },
  "readable.read": { argTypes: [null, F64], result: VOID },
  "readable.pause": { argTypes: [null], result: VOID },
  "readable.setEncoding": { argTypes: [null, STRING], result: VOID },
  "readable.pushStrEnc": { argTypes: [null, STRING, STRING], result: BOOL },
  "readable.pushEncoding": { argTypes: [null, STRING], result: VOID },
  "readable.nextChunk": { argTypes: [null], result: VOID },
  "readable.nextChunkDyn": { argTypes: [null], result: VOID },
  "readable.fromArr": { argTypes: [null, BOOL], result: VOID },
  "readable.resume": { argTypes: [null], result: VOID },
  "readable.isPaused": { argTypes: [null], result: BOOL },
  "readable.pipe": { argTypes: [null, null, BOOL], result: VOID },
  "readable.unpipe": { argTypes: [null], result: VOID },
  "readable.flowing": { argTypes: [null], result: VOID },
  "writable.write": { argTypes: [null, BYTES_U8], result: BOOL },
  "writable.writeStr": { argTypes: [null, STRING], result: BOOL },
  "writable.writeU": { argTypes: [null, null], result: BOOL },
  "writable.writeDyn": { argTypes: [null, DYN], result: BOOL },
  "writable.end": { argTypes: [null, F64], result: VOID },
  "writable.cork": { argTypes: [null], result: VOID },
  "writable.uncork": { argTypes: [null], result: VOID },
  "stream.destroy": { argTypes: [null], result: VOID },
  "stream.destroyErr": { argTypes: [null, null], result: VOID },
  "stream.prop": { argTypes: [null, STRING], result: VOID },
  "stream.errored": { argTypes: [null], result: VOID },
  // node:assert: pass/negated/deep/hasMsg are frontend-computed bools; the
  // message slot always carries a string ("" when hasMsg is false).
  "assert.ok": { argTypes: [BOOL, STRING], result: VOID },
  "assert.eqF64": { argTypes: [F64, F64, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqStr": { argTypes: [STRING, STRING, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqBool": { argTypes: [BOOL, BOOL, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.deepResult": { argTypes: [BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.sameValue": { argTypes: [F64, F64], result: BOOL },
  // The deep-equality pair memo: both slots are program-dependent
  // (any cycle-capable record/array/map type).
  "assert.deqEnter": { argTypes: [null, null], result: BOOL },
  "assert.deqLeave": { argTypes: [], result: VOID },
  "assert.match": { argTypes: [STRING, REGEX, BOOL, STRING, BOOL], result: VOID },
  "assert.throwsNone": { argTypes: [BOOL, STRING, BOOL, STRING, BOOL], result: VOID },
  "assert.throwsMismatch": { argTypes: [STRING, { kind: "object", className: "%Error" }, STRING, BOOL], result: VOID },
  "assert.throwsRegex": { argTypes: [REGEX, { kind: "object", className: "%Error" }, STRING, BOOL], result: VOID },
  // Symbol strict equality (pointer identity; scr_symbol.c).
  "assert.eqSym": { argTypes: [{ kind: "symbol" }, { kind: "symbol" }, BOOL, BOOL, STRING, BOOL], result: VOID },
  // The equality quartet over checked-dynamic operands (the frontend
  // boxes a static side into the checked-dynamic tree first).
  "assert.eqDyn": { argTypes: [DYN, DYN, BOOL, BOOL, STRING, BOOL], result: VOID },
  // The throws(fn, {shape}) accumulator: begin/slot calls never throw;
  // shapeEnd throws the Comparison diff. The error slot is the
  // %Error-narrowed caught value.
  "assert.shapeBegin": { argTypes: [{ kind: "object", className: "%Error" }], result: VOID },
  "assert.shapeStr": { argTypes: [F64, STRING], result: VOID },
  "assert.shapeRe": { argTypes: [F64, REGEX], result: VOID },
  "assert.shapeEnd": { argTypes: [STRING, BOOL], result: VOID },
  "assert.regexErrTest": { argTypes: [REGEX, { kind: "object", className: "%Error" }], result: BOOL },
  "assert.unwantedRejection": { argTypes: [{ kind: "object", className: "%Error" }, STRING, BOOL], result: VOID },
  "assert.expectsErrDyn": { argTypes: [DYN, DYN, STRING, BOOL], result: VOID },
  // assert.ifError's typed entries (always throw; unit args never
  // lower). The error slot is program-dependent — any %Error-hierarchy
  // class, root or subclass (the insp.error precedent, null slot).
  "assert.ifErrorErr": { argTypes: [null], result: VOID },
  "assert.ifErrorF64": { argTypes: [F64], result: VOID },
  "assert.ifErrorStr": { argTypes: [STRING], result: VOID },
  "assert.ifErrorBool": { argTypes: [BOOL], result: VOID },
  "assert.ifErrorDyn": { argTypes: [DYN], result: VOID },
  // Bytes equality: the two value slots are any bytes kind (the frontend
  // gates both sides to ONE static bytes type; the libCall case checks
  // the kind and the pair below).
  "assert.refEqBytes": { argTypes: [null, null, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.refEqFn": { argTypes: [null, null, BOOL, STRING, BOOL], result: VOID },
  "assert.bytesDeepEq": { argTypes: [null, null, BOOL], result: BOOL },
  // util.inspect: the error receiver is program-dependent (a builtin or
  // user error class — the error.toString precedent, null slot).
  "insp.f64": { argTypes: [F64], result: STRING },
  "insp.jsonDyn": { argTypes: [DYN], result: STRING },
  "insp.str": { argTypes: [STRING], result: STRING },
  "insp.regex": { argTypes: [REGEX], result: STRING },
  "insp.buffer": { argTypes: [BYTES_U8], result: STRING },
  "insp.error": { argTypes: [null, F64, F64], result: STRING },
  "insp.dyn": { argTypes: [DYN, F64, F64], result: STRING },
  "insp.dynS": { argTypes: [DYN, F64], result: STRING },
  "insp.jsval": { argTypes: [JSVAL, F64, F64], result: STRING },
  "insp.begin": { argTypes: [F64], result: VOID },
  "insp.entry": { argTypes: [STRING, BOOL], result: VOID },
  // Circular references: the receiver slot is program-dependent (any
  // cycle-capable record/array/map/class type — the insp.error precedent).
  "insp.circCheck": { argTypes: [null], result: F64 },
  "insp.seenPush": { argTypes: [null], result: VOID },
  "insp.refWrap": { argTypes: [null, STRING], result: STRING },
  "insp.circular": { argTypes: [F64], result: STRING },
  "insp.key": { argTypes: [STRING], result: STRING },
  "insp.moreItems": { argTypes: [F64], result: STRING },
  "insp.end": { argTypes: [STRING, STRING, STRING, F64, BOOL, BOOL], result: STRING },
  "strdec.write": { argTypes: [STRING, F64, BYTES_U8], result: STRING },
  "strdec.next": { argTypes: [STRING, F64, BYTES_U8], result: F64 },
  "strdec.end": { argTypes: [STRING, F64], result: STRING },
  // node:readline: the interface handle is f64; the callbacks' func types
  // are program-dependent (zero-param or (answer: string) — the emitter
  // picks the adapter), so those slots are null like child.onExit's.
  "rl.create": { argTypes: [], result: F64 },
  "rl.question": { argTypes: [F64, STRING, null], result: VOID },
  "rl.close": { argTypes: [F64], result: VOID },
  "rl.onClose": { argTypes: [F64, null], result: VOID },
  "tp.setTimeout": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "tp.setImmediate": { argTypes: [], result: { kind: "promise", inner: VOID } },
  "dc.channel": { argTypes: [STRING], result: F64 },
  "dc.subscribe": { argTypes: [STRING, DYN], result: VOID },
  "dc.unsubscribe": { argTypes: [STRING, DYN], result: BOOL },
  "dc.hasSubscribers": { argTypes: [STRING], result: BOOL },
  "dc.publish": { argTypes: [F64, DYN], result: VOID },
  "dc.chanSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.chanUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.chanHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.chanName": { argTypes: [F64], result: STRING },
  "timers.setImmediateFnValue": { argTypes: [], result: DYN },
  "timers.immediatePromise": { argTypes: [], result: { kind: "promise", inner: DYN } },
  "dc.tracingChannel": { argTypes: [STRING], result: F64 },
  "dc.tracingChannelOf": { argTypes: [F64, F64, F64, F64, F64], result: F64 },
  "dc.tcChannel": { argTypes: [F64, F64], result: F64 },
  "dc.tcHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.tcSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.tcUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.tcTraceSync": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  "dc.tcTraceCallback": { argTypes: [F64, DYN, F64, DYN, DYN, DYN], result: DYN },
  "dc.tcTracePromise": { argTypes: [F64, DYN, DYN, DYN, DYN], result: { kind: "promise", inner: DYN } },
  "process.onUnhandledRejection": { argTypes: [DYN, BOOL], result: VOID },
  "process.offUnhandledRejection": { argTypes: [DYN], result: VOID },
  "process.onRejectionHandled": { argTypes: [DYN, BOOL], result: VOID },
  "process.offRejectionHandled": { argTypes: [DYN], result: VOID },
  "process.onWarning": { argTypes: [DYN], result: VOID },
  "process.offWarning": { argTypes: [DYN], result: VOID },
  "process.emitWarning": { argTypes: [DYN], result: VOID },
  "async.awaitDyn": { argTypes: [DYN], result: DYN },
  "async.hop": { argTypes: [], result: VOID },
  "als.new": { argTypes: [], result: F64 },
  "als.get": { argTypes: [F64], result: DYN },
  "als.run": { argTypes: [F64, DYN, DYN, DYN], result: DYN },
  "als.exitRun": { argTypes: [F64, DYN, DYN], result: DYN },
  "als.enterWith": { argTypes: [F64, DYN], result: VOID },
  "als.disable": { argTypes: [F64], result: VOID },
  "dc.chanBindStore": { argTypes: [F64, F64, DYN], result: VOID },
  "dc.chanUnbindStore": { argTypes: [F64, F64], result: BOOL },
  "dc.chanRunStores": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  "number.isFinite": { argTypes: [F64], result: BOOL },
  "number.isNaN": { argTypes: [F64], result: BOOL },
  "number.isInteger": { argTypes: [F64], result: BOOL },
  "number.isSafeInteger": { argTypes: [F64], result: BOOL },
  "date.now": { argTypes: [], result: F64 },
  "date.newNow": { argTypes: [], result: DATE_T },
  "date.newMs": { argTypes: [F64], result: DATE_T },
  "date.newString": { argTypes: [STRING], result: DATE_T },
  "date.getTime": { argTypes: [DATE_T], result: F64 },
  "date.valueOf": { argTypes: [DATE_T], result: F64 },
  "date.toISOString": { argTypes: [F64], result: STRING },
  "date.toISOStringValue": { argTypes: [DATE_T], result: STRING },
  "date.getFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getUTCFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getMonth": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMonth": { argTypes: [DATE_T], result: F64 },
  "date.getDate": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDate": { argTypes: [DATE_T], result: F64 },
  "date.getDay": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDay": { argTypes: [DATE_T], result: F64 },
  "date.getHours": { argTypes: [DATE_T], result: F64 },
  "date.getUTCHours": { argTypes: [DATE_T], result: F64 },
  "date.getMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getTimezoneOffset": { argTypes: [DATE_T], result: F64 },
  "date.parseGetTime": { argTypes: [STRING], result: F64 },
  "date.utc": { argTypes: [F64, F64, F64, F64, F64, F64, F64], result: F64 },
  "text.decode": { argTypes: [BYTES_U8], result: STRING },
  "text.decodeLegacy": { argTypes: [BYTES_U8, F64], result: STRING },
  "fs.mkdirRecursiveSync": { argTypes: [STRING], result: VOID },
  "fs.rmOptsSync": { argTypes: [STRING, BOOL, BOOL], result: VOID },
  "fs.rmRetrySync": { argTypes: [STRING, BOOL, BOOL, F64, F64], result: VOID },
  "fs.mkdtempSync": { argTypes: [STRING], result: STRING },
  "fs.accessSync": { argTypes: [STRING, F64], result: VOID },
  "fs.readFdSync": { argTypes: [F64, STRING], result: STRING },
  "fs.readFdSyncBytes": { argTypes: [F64], result: BYTES_U8 },
  "process.isTTY": { argTypes: [F64], result: BOOL },
  // Like process.envGet: the result is the module's interned
  // `number | undefined` union — checked by arms in the libCall case.
  "process.columns": { argTypes: [F64], result: VOID },
  "process.stdinDestroy": { argTypes: [], result: VOID },
  "process.stdinSetRawMode": { argTypes: [BOOL], result: VOID },
  // Arg 0 is a packed f64[] OR a bytes value (the spread-typed-array
  // form) — checked in the libCall case.
  "string.fromCharCode": { argTypes: [null], result: STRING },
  "string.lastIndexOf": { argTypes: [STRING, STRING], result: F64 },
  "string.raw": { argTypes: [arrayOf(STRING), arrayOf(STRING)], result: STRING },
};

/** True for an object type naming a runtime-provided error class. */
function isBuiltinErrorObject(t: IrType): boolean {
  return t.kind === "object" && RUNTIME_ERROR_CLASSES.has(t.className);
}

export interface IrValidationError {
  message: string;
  loc: SrcLoc;
}

/** The type a CALL SITE (or function value) receives from a module
 * function: an async body's returnType is the promise's INNER type, so
 * calls and closures over it see Promise<T>; a generator body's is the
 * TReturn channel, so call sites see the generator type. The one place
 * the body/call-site split is spelled out in the validator. */
function callSiteReturnType(fn: IrFunction): IrType {
  if (fn.async) return { kind: "promise", inner: fn.returnType };
  if (fn.generator !== undefined) {
    return { kind: "generator", yieldT: fn.generator.yieldT, retT: fn.returnType, nextT: fn.generator.nextT };
  }
  return fn.returnType;
}

export function validateModule(mod: IrModule): IrValidationError[] {
  const errors: IrValidationError[] = [];
  const functionsByName = new Map<string, IrFunction>();
  for (const fn of mod.functions) {
    if (functionsByName.has(fn.name)) {
      errors.push({ message: `duplicate function "${fn.name}"`, loc: fn.loc });
    }
    if (fn.async && fn.generator !== undefined) {
      errors.push({ message: `function "${fn.name}" is both async and a generator (async generators are fenced)`, loc: fn.loc });
    }
    functionsByName.set(fn.name, fn);
  }
  const ffiByName = new Map<string, NonNullable<IrModule["ffiImports"]>[number]>();
  const ffiSymbols = new Set<string>();
  const moduleLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  for (const entry of mod.ffiImports ?? []) {
    if (ffiByName.has(entry.name)) {
      errors.push({ message: `duplicate FFI binding "${entry.name}"`, loc: moduleLoc });
    }
    if (ffiSymbols.has(entry.symbol)) {
      errors.push({ message: `duplicate FFI symbol "${entry.symbol}"`, loc: moduleLoc });
    }
    ffiByName.set(entry.name, entry);
    ffiSymbols.add(entry.symbol);
  }
  // The lib section (library mode): every mapped function exists, is
  // synchronous, and its IR signature fits the declared marshalling
  // classes — the SC4xxx refusals ran before this landed on the module, so
  // a violation here is a compiler bug like any other validation error.
  if (mod.lib !== undefined) {
    const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
    for (const e of mod.lib.exports) {
      const fn = functionsByName.get(e.fnName);
      if (!fn) {
        errors.push({ message: `library export "${e.symbol}": missing function "${e.fnName}"`, loc: entryLoc });
        continue;
      }
      if (fn.async === true || fn.generator !== undefined) {
        errors.push({ message: `library export "${e.symbol}": "${e.fnName}" is async/generator`, loc: fn.loc });
      }
      if (fn.captures !== undefined) {
        errors.push({ message: `library export "${e.symbol}": "${e.fnName}" captures an environment`, loc: fn.loc });
      }
      if (fn.params.length !== e.params.length) {
        errors.push({
          message: `library export "${e.symbol}": ${e.params.length} marshalling classes over ${fn.params.length} params`,
          loc: fn.loc,
        });
        continue;
      }
      const fits = (cls: string, t: IrType): boolean =>
        cls === "bool"
          ? t.kind === "bool"
          : cls === "string"
            ? t.kind === "string"
            : cls === "bytes"
              ? t.kind === "bytes" && t.elem === "u8"
              : t.kind === "f64"; // f64 + the integer plumbing classes
      e.params.forEach((cls, i) => {
        if (!fits(cls, fn.params[i]!.type)) {
          errors.push({
            message: `library export "${e.symbol}": param ${i} class "${cls}" over IR type "${fn.params[i]!.type.kind}"`,
            loc: fn.loc,
          });
        }
      });
      if (e.returns === "void" ? fn.returnType.kind !== "void" : !fits(e.returns, fn.returnType)) {
        errors.push({
          message: `library export "${e.symbol}": return class "${e.returns}" over IR type "${fn.returnType.kind}"`,
          loc: fn.loc,
        });
      }
    }
    if (!functionsByName.has(mod.entry)) {
      errors.push({ message: `library module missing its entry function "${mod.entry}"`, loc: entryLoc });
    }
  }
  const classesByName = new Map<string, IrClassDef>();
  for (const cls of mod.classes ?? []) {
    if (classesByName.has(cls.name)) {
      errors.push({ message: `duplicate class "${cls.name}"`, loc: cls.loc });
    }
    classesByName.set(cls.name, cls);
    const seen = new Set<string>();
    for (const f of cls.fields) {
      if (seen.has(f.name)) {
        errors.push({ message: `class ${cls.name}: duplicate field "${f.name}"`, loc: cls.loc });
      }
      seen.add(f.name);
      if (isUnitType(f.type)) {
        errors.push({ message: `class ${cls.name}: field "${f.name}" is ${f.type.kind}`, loc: cls.loc });
      }
    }
    // Constructor presence is checked at `new` sites (below): a class kept
    // only for its layout/type (reachability never constructs it) carries
    // no constructor function, and that is fine — nothing calls it.
    // ABSTRACT entries are declarations without bodies by definition — no
    // module function exists for them (and must not).
    for (const m of cls.abstractMethods ?? []) {
      if (!cls.methods?.includes(m)) {
        errors.push({ message: `class ${cls.name}: abstract method "${m}" not in methods`, loc: cls.loc });
      }
      if (functionsByName.has(`%${cls.name}.${m}`)) {
        errors.push({ message: `class ${cls.name}: abstract method "${m}" has a function`, loc: cls.loc });
      }
    }
    for (const m of cls.methods ?? []) {
      if (cls.abstractMethods?.includes(m)) continue;
      if (!functionsByName.has(`%${cls.name}.${m}`)) {
        errors.push({ message: `class ${cls.name}: missing method function "${m}"`, loc: cls.loc });
      }
    }
  }
  // Hierarchy invariants: bases exist, the graph is acyclic, and every
  // derived class's field list starts with its base's EXACTLY (the prefix
  // layout that makes upcasts pointer reinterprets).
  for (const cls of mod.classes ?? []) {
    if (cls.base === undefined) continue;
    const base = classesByName.get(cls.base);
    if (!base) {
      errors.push({ message: `class ${cls.name}: undeclared base "${cls.base}"`, loc: cls.loc });
      continue;
    }
    const seen = new Set<string>([cls.name]);
    for (let c: IrClassDef | undefined = base; c; c = c.base !== undefined ? classesByName.get(c.base) : undefined) {
      if (seen.has(c.name)) {
        errors.push({ message: `class ${cls.name}: cyclic extends chain`, loc: cls.loc });
        break;
      }
      seen.add(c.name);
    }
    if (
      cls.fields.length < base.fields.length ||
      base.fields.some(
        (f, i) => cls.fields[i]!.name !== f.name || !typeEquals(cls.fields[i]!.type, f.type),
      )
    ) {
      errors.push({
        message: `class ${cls.name}: fields are not a layout extension of base "${cls.base}"`,
        loc: cls.loc,
      });
    }
  }
  // Generic-class instantiations: the named FAMILY exists and is a proper
  // ancestor (the class object's interval is read off it — see IrClassDef).
  for (const cls of mod.classes ?? []) {
    if (cls.genericOf === undefined) continue;
    const family = classesByName.get(cls.genericOf);
    if (!family) {
      errors.push({ message: `class ${cls.name}: undeclared generic family "${cls.genericOf}"`, loc: cls.loc });
      continue;
    }
    let ancestor = false;
    const seen = new Set<string>();
    for (let c = cls.base !== undefined ? classesByName.get(cls.base) : undefined; c && !seen.has(c.name); c = c.base !== undefined ? classesByName.get(c.base) : undefined) {
      seen.add(c.name);
      if (c.name === cls.genericOf) {
        ancestor = true;
        break;
      }
    }
    if (!ancestor) {
      errors.push({ message: `class ${cls.name}: generic family "${cls.genericOf}" is not an ancestor`, loc: cls.loc });
    }
  }
  const noLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const recordsById = new Map<string, IrRecordShape>();
  for (const rec of mod.records ?? []) {
    if (recordsById.has(rec.id)) {
      errors.push({ message: `duplicate record shape "${rec.id}"`, loc: noLoc });
    }
    recordsById.set(rec.id, rec);
    const seen = new Set<string>();
    for (const f of rec.fields) {
      if (seen.has(f.name)) {
        errors.push({ message: `record ${rec.id}: duplicate field "${f.name}"`, loc: noLoc });
      }
      seen.add(f.name);
      // Unit kinds (undefinedT/nullT) exist only as union arms — a BARE
      // unit field is as malformed as a void one. dyn fields are VALID
      // (`[string, unknown]` entries tuples, `{ v: unknown }` records):
      // the slot holds a dyn value with the overflow map's plumbing.
      if (
        f.type.kind === "void" || f.type.kind === "jsval" ||
        isUnitType(f.type)
      ) {
        errors.push({ message: `record ${rec.id}: field "${f.name}" is ${f.type.kind}`, loc: noLoc });
      }
      if (f.type.kind === "record" && !new Set((mod.records ?? []).map((r) => r.id)).has(f.type.shapeId)) {
        errors.push({
          message: `record ${rec.id}: field "${f.name}" references undeclared shape "${f.type.shapeId}"`,
          loc: noLoc,
        });
      }
    }
    // Canonical order is the shape's identity — enforce it.
    const sorted = [...rec.fields].map((f) => f.name).sort();
    if (rec.fields.some((f, i) => f.name !== sorted[i])) {
      errors.push({ message: `record ${rec.id}: fields are not in canonical (sorted) order`, loc: noLoc });
    }
    // Tuple shapes carry exactly the positional fields "0".."n-1" (arity =
    // field count) — anything else has no honest index/JSON story.
    if (rec.tuple) {
      const names = new Set(rec.fields.map((f) => f.name));
      if (
        rec.fields.length === 0 ||
        names.size !== rec.fields.length ||
        [...Array(rec.fields.length).keys()].some((i) => !names.has(String(i)))
      ) {
        errors.push({ message: `record ${rec.id}: tuple fields are not "0".."${rec.fields.length - 1}"`, loc: noLoc });
      }
      if (rec.indexValue) {
        errors.push({ message: `record ${rec.id}: a tuple cannot carry an index signature`, loc: noLoc });
      }
    }
    // Index-signature shapes: the overflow value type is fenced to the map
    // VALUE kinds plus dyn (`unknown` signatures) — isSupportedIndexValue.
    if (rec.indexValue && !isSupportedIndexValue(rec.indexValue)) {
      errors.push({
        message: `record ${rec.id}: index-signature value type ${rec.indexValue.kind} is unsupported`,
        loc: noLoc,
      });
    }
  }
  const unionsById = new Map<string, IrUnionDef>();
  for (const u of mod.unions ?? []) {
    if (unionsById.has(u.id)) {
      errors.push({ message: `duplicate union "${u.id}"`, loc: noLoc });
    }
    unionsById.set(u.id, u);
    if (u.arms.length < 2) {
      errors.push({ message: `union ${u.id}: fewer than 2 arms`, loc: noLoc });
    }
    u.arms.forEach((arm, i) => {
      // The unit kinds (undefinedT/nullT) are valid arms — union membership
      // is the ONLY place they may appear; void/union/map/dyn/jsval/date
      // stay out (maps and scalar Date values have no supported union
      // representation/discriminant to narrow on). Func/set arm
      // sibling rules live in unionFuncSetArmsOk (shared with the frontend's
      // union builders): a func arm allows unit and FUNC siblings (the
      // nullable-callback shape, and the primitive-constructor tables where
      // closure pointer identity per tag is the narrowing); a set arm is
      // valid exactly when every other arm is a unit (the defaulted-Set-
      // param ABI); func/set-beside-data stays out.
      if (
        arm.kind === "void" ||
        arm.kind === "union" ||
        arm.kind === "map" ||
        arm.kind === "dyn" ||
        arm.kind === "jsval" ||
        arm.kind === "date" ||
        arm.kind === "generator"
      ) {
        errors.push({ message: `union ${u.id}: arm ${i} is ${arm.kind}`, loc: noLoc });
      }
      if (
        (arm.kind === "func" || arm.kind === "set") &&
        !unionFuncSetArmsOk(u.arms)
      ) {
        errors.push({ message: `union ${u.id}: ${arm.kind} arm ${i} beside non-unit arms`, loc: noLoc });
      }
      if (arm.kind === "record" && !recordsById.has(arm.shapeId)) {
        errors.push({
          message: `union ${u.id}: arm ${i} references undeclared shape "${arm.shapeId}"`,
          loc: noLoc,
        });
      }
      // classval arms may name UNDECLARED classes: the payload emits as
      // the class-independent `ScrClassObj *` (see the namesUndeclared
      // backstop below) — a fenced class's value slot is inert-but-valid.
      for (let j = i + 1; j < u.arms.length; j++) {
        if (typeEquals(arm, u.arms[j]!)) {
          errors.push({ message: `union ${u.id}: arms ${i} and ${j} are identical`, loc: noLoc });
        }
      }
    });
  }
  const globalsById = new Map((mod.globals ?? []).map((g) => [g.id, g]));
  // Every class an emitted type slot names as an OBJECT type must be
  // DECLARED: the emitter writes the class's own struct type and typed
  // retain/release calls for such slots, so an unregistered class there
  // is invalid C waiting to happen (the compile-C escape family — a JS
  // class whose collection fenced, with the object-typed slot left
  // behind; run() prunes the dead ones, and this is the backstop that
  // turns any live escape into an ICE instead of a clang error). CLASSVAL
  // types are exempt: every class value emits as the one class-independent
  // `ScrClassObj *` (constructing/dispatching through it re-resolves the
  // class and carries its own lowering-time fence), so a classval naming
  // a fenced class is inert-but-valid storage, the honest leftovers of a
  // runtime-fenced declaration.
  const namesUndeclared = (t: IrType, seen: Set<string>): string | null => {
    switch (t.kind) {
      case "object":
        return classesByName.has(t.className) ? null : t.className;
      case "array":
      case "set":
        return namesUndeclared(t.elem, seen);
      case "map":
        return namesUndeclared(t.key, seen) ?? namesUndeclared(t.value, seen);
      case "promise":
        return namesUndeclared(t.inner, seen);
      case "generator":
        return (
          namesUndeclared(t.yieldT, seen) ??
          namesUndeclared(t.retT, seen) ??
          namesUndeclared(t.nextT, seen)
        );
      case "func":
        for (const p of t.params) {
          const hit = namesUndeclared(p, seen);
          if (hit) return hit;
        }
        return namesUndeclared(t.ret, seen);
      case "record": {
        if (seen.has(t.shapeId)) return null;
        seen.add(t.shapeId);
        const rec = recordsById.get(t.shapeId);
        if (!rec) return null; // its own undeclared-shape check reports
        if (rec.indexValue) {
          const hit = namesUndeclared(rec.indexValue, seen);
          if (hit) return hit;
        }
        for (const f of rec.fields) {
          const hit = namesUndeclared(f.type, seen);
          if (hit) return hit;
        }
        return null;
      }
      case "union": {
        if (seen.has(t.unionId)) return null;
        seen.add(t.unionId);
        const def = unionsById.get(t.unionId);
        if (!def) return null;
        for (const a of def.arms) {
          const hit = namesUndeclared(a, seen);
          if (hit) return hit;
        }
        return null;
      }
      default:
        return null;
    }
  };
  for (const g of mod.globals ?? []) {
    if (isUnitType(g.type)) {
      errors.push({ message: `global "${g.name}" has bare unit type ${g.type.kind}`, loc: noLoc });
    }
    if (!g.id.startsWith("%g.")) {
      errors.push({
        message: `global "${g.name}" id "${g.id}" outside the %g. namespace`,
        loc: { file: mod.sourceFile, start: 0, end: 0 },
      });
    }
    const undeclared = namesUndeclared(g.type, new Set());
    if (undeclared !== null) {
      errors.push({
        message: `global "${g.name}" names undeclared class "${undeclared}"`,
        loc: noLoc,
      });
    }
  }
  // The same backstop over class LAYOUTS: a field typed by an undeclared
  // class emits that class's struct type and release call into the TU —
  // the exact invalid-C escape the global check catches, one level deeper
  // (the anonymous-CJS-export shape reached emission through a class
  // FIELD, never a global). Function locals and returns stay UNCHECKED:
  // a local typed by an uncollected class is a pinned-valid module state
  // (the runtime-fenced-JS-class story — captured locals emit inert
  // trapping boxes; see boxNewC's uncollected-class placeholder), where a
  // field slot embeds the raw struct pointer and has no degradation.
  for (const cls of mod.classes ?? []) {
    for (const f of cls.fields) {
      const undeclared = namesUndeclared(f.type, new Set());
      if (undeclared !== null) {
        errors.push({
          message: `class ${cls.name}: field "${f.name}" names undeclared class "${undeclared}"`,
          loc: cls.loc,
        });
      }
    }
  }
  for (const fn of mod.functions) {
    validateFunction(
      fn,
      functionsByName,
      ffiByName,
      classesByName,
      recordsById,
      unionsById,
      globalsById,
      errors,
    );
  }
  return errors;
}

function validateFunction(
  fn: IrFunction,
  functions: Map<string, IrFunction>,
  ffiByName: Map<string, NonNullable<IrModule["ffiImports"]>[number]>,
  classes: Map<string, IrClassDef>,
  records: Map<string, IrRecordShape>,
  unions: Map<string, IrUnionDef>,
  globals: Map<string, IrGlobal>,
  errors: IrValidationError[],
): void {
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const err = (message: string, loc: SrcLoc) =>
    errors.push({ message: `in ${fn.name}: ${message}`, loc });

  const asyncCaches = [
    ["asyncCacheGlobal", fn.asyncCacheGlobal],
    ["asyncCycleCacheGlobal", fn.asyncCycleCacheGlobal],
  ] as const;
  for (const [field, cacheId] of asyncCaches) {
    if (cacheId === undefined) continue;
    if (fn.async !== true) {
      err(`an ${field} is only valid on an async function`, fn.loc);
    }
    if (fn.params.length !== 0 || (fn.captures?.length ?? 0) !== 0) {
      err("a cached async function must have no parameters or captures", fn.loc);
    }
    const cache = globals.get(cacheId);
    if (cache === undefined) {
      err(`async cache names undeclared global "${cacheId}"`, fn.loc);
    } else {
      const expected: IrType = { kind: "promise", inner: fn.returnType };
      if (!typeEquals(cache.type, expected)) {
        err(
          `async cache global "${cacheId}" has type ${typeKey(cache.type)}, expected ${typeKey(expected)}`,
          fn.loc,
        );
      }
      if (!cache.mutable) {
        err(`async cache global "${cacheId}" is immutable`, fn.loc);
      }
    }
  }
  if (fn.asyncCycleCacheGlobal !== undefined && fn.asyncCacheGlobal === undefined) {
    err("an asyncCycleCacheGlobal requires a module asyncCacheGlobal", fn.loc);
  }

  // The class graph's two questions (upcast/downcast/instanceOf/virtualCall
  // legality): strict-descendant tests over the base links, and hierarchy
  // membership (a class that extends or is extended).
  const isStrictSubclass = (sub: string, sup: string): boolean => {
    for (
      let c = classes.get(sub);
      c?.base !== undefined;
      c = classes.get(c.base)
    ) {
      if (c.base === sup) return true;
    }
    return false;
  };
  const hierarchy = new Set<string>();
  for (const c of classes.values()) {
    if (c.base !== undefined) {
      hierarchy.add(c.name);
      hierarchy.add(c.base);
    }
    // The runtime emitter class is ALWAYS a hierarchy member: ScrEmitter
    // carries its vtable word even with no subclass in the program.
    if (c.name === RUNTIME_EMITTER_CLASS) hierarchy.add(c.name);
  }

  // Unit kinds live only inside unions: a bare-unit local, param, or
  // return type is frontend breakage (mapType never produces them).
  for (const l of fn.locals) {
    if (isUnitType(l.type)) err(`local "${l.name}" has bare unit type ${l.type.kind}`, fn.loc);
  }
  if (isUnitType(fn.returnType)) {
    err(`return type is bare unit type ${fn.returnType.kind}`, fn.loc);
  }
  // Caught (catch-binding) values are local-only by construction: they can
  // never be parameters, returns, or captures (the frontend fences every
  // escape; a caught anywhere else is frontend breakage).
  if (fn.returnType.kind === "caught") err("return type is caught", fn.loc);
  for (const p of fn.params) {
    if (!locals.has(p.localId)) {
      err(`param "${p.name}" has no local entry "${p.localId}"`, fn.loc);
    }
    if (p.type.kind === "caught") err(`param "${p.name}" is caught-typed`, fn.loc);
  }
  for (const c of fn.captures ?? []) {
    const local = locals.get(c.localId);
    if (!local) err(`capture "${c.name}" has no local entry "${c.localId}"`, fn.loc);
    else if (!local.boxed) err(`capture local "${c.localId}" is not boxed`, fn.loc);
    if (c.type.kind === "caught") err(`capture "${c.name}" is caught-typed`, fn.loc);
  }

  const expectType = (expr: IrExpr, want: IrType, what: string) => {
    if (!typeEquals(expr.type, want)) {
      // Same-kind mismatches (func vs func, record vs record) would be
      // unreadable as bare kinds — the structural keys show WHERE the two
      // types diverge.
      const detail =
        want.kind === expr.type.kind ? ` (expected ${typeKey(want)}, got ${typeKey(expr.type)})` : "";
      err(`${what}: expected ${want.kind}, got ${expr.type.kind}${detail}`, expr.loc);
    }
  };

  /** Union arms a truthiness helper can answer: units (false), scalars and
   * strings (per-value), ref kinds (always true), jsval (the engine
   * answers). dyn/caught arms have no ToBoolean — the frontend fences them
   * before emitting toBool/logical over the union. */
  const checkTruthyUnion = (unionId: string, loc: SrcLoc) => {
    const def = unions.get(unionId);
    if (!def) {
      err(`truthiness of unknown union ${unionId}`, loc);
      return;
    }
    for (const arm of def.arms) {
      if (arm.kind === "dyn" || arm.kind === "caught" || arm.kind === "void") {
        err(`truthiness of union with ${arm.kind} arm`, loc);
      }
    }
  };

  // Optional chains open a binding scope: chainRecv is valid only inside
  // the body of the optChain whose id it names.
  const activeChains = new Map<string, IrType>();

  const liveDynRefEligible = (
    type: IrType,
    seen = new Set<string>(),
  ): boolean => {
    if (
      type.kind === "record" ||
      type.kind === "array" ||
      type.kind === "bytes"
    ) {
      return true;
    }
    if (type.kind !== "union" || seen.has(type.unionId)) return false;
    seen.add(type.unionId);
    return unions.get(type.unionId)?.arms.some((arm) =>
      liveDynRefEligible(arm, seen)
    ) ?? false;
  };

  function checkExpr(e: IrExpr): void {
    switch (e.kind) {
      case "numLit":
        // ±Infinity and NaN are real literals (the globals
        // `Infinity`/`NaN`, Number constants) — both backends spell them
        // (INFINITY/NAN macros in C, bit-encoded f64 in LLVM).
        // procStream is the ONE non-f64 numLit: process.stdout/stderr as
        // first-class values mint the stream's fd (1/2) as the scalar —
        // the prefixStream idiom.
        if (e.type.kind !== "f64" && !(e.type.kind === "procStream" && (e.value === 1 || e.value === 2))) {
          err("numLit must be f64", e.loc);
        }
        break;
      case "strLit":
        if (e.type.kind !== "string") err("strLit must be string", e.loc);
        break;
      case "boolLit":
        if (e.type.kind !== "bool") err("boolLit must be bool", e.loc);
        break;
      case "unitLit":
        // Reachable only for a unitLit OUTSIDE a unionWrap (the wrap case
        // validates its unit value inline) — unit types have no standalone
        // runtime value, so a bare one is frontend breakage.
        err(`bare unitLit '${e.unit}' outside a unionWrap`, e.loc);
        break;
      case "varRef": {
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`varRef to undeclared local/global "${e.localId}"`, e.loc);
        else if (!typeEquals(binding.type, e.type)) {
          err(`varRef "${e.localId}" type ${e.type.kind} != binding ${binding.type.kind}`, e.loc);
        }
        break;
      }
      case "bin": {
        checkExpr(e.left);
        checkExpr(e.right);
        const isEq = e.op === "===" || e.op === "!==";
        if (isEq && e.left.type.kind === "func") {
          // Function identity tolerates DIFFERING static signatures (the
          // compare is pointer equality; tsc gates the overlap).
          if (e.right.type.kind !== "func") {
            err(`bin ${e.op} on functions: right operand is ${e.right.type.kind}`, e.loc);
          }
        } else if (isEq && e.left.type.kind === "classval") {
          // Class identity tolerates DIFFERING static classes like
          // function identity does signatures: one immortal object per
          // class, one pointer compare (tsc gates the overlap).
          if (e.right.type.kind !== "classval") {
            err(`bin ${e.op} on class values: right operand is ${e.right.type.kind}`, e.loc);
          }
        } else if (
          isEq &&
          (e.left.type.kind === "array" ||
            e.left.type.kind === "map" ||
            e.left.type.kind === "set" ||
            e.left.type.kind === "object" ||
            e.left.type.kind === "record" ||
            // Symbol identity IS pointer identity (the frontend's rule).
            e.left.type.kind === "symbol" ||
            e.left.type.kind === "bytes" ||
            e.left.type.kind === "promise" ||
            // Runtime handles are objects to === (one handle per socket/
            // request — pointer identity is JS's object equality).
            DYN_HANDLE_KINDS.has(e.left.type.kind))
        ) {
          // Reference identity: both operands must be the same ref type.
          if (!typeEquals(e.left.type, e.right.type)) {
            err(`bin ${e.op} on references: operand types differ`, e.loc);
          }
        } else if (isEq && e.left.type.kind === "bool") {
          // bool === bool: a plain value compare.
          expectType(e.right, { kind: "bool" }, `bin ${e.op} right`);
        } else {
          expectType(e.left, { kind: "f64" }, `bin ${e.op} left`);
          expectType(e.right, { kind: "f64" }, `bin ${e.op} right`);
        }
        const isCompare = ["<", "<=", ">", ">=", "===", "!=="].includes(e.op);
        if (!typeEquals(e.type, isCompare ? BOOL : { kind: "f64" })) {
          err(`bin ${e.op} result must be ${isCompare ? "bool" : "f64"}`, e.loc);
        }
        break;
      }
      case "unary":
        checkExpr(e.operand);
        if (e.op === "-" || e.op === "~") {
          expectType(e.operand, { kind: "f64" }, `unary ${e.op}`);
          if (e.type.kind !== "f64") err(`unary ${e.op} must be f64`, e.loc);
        } else {
          expectType(e.operand, BOOL, "unary !");
          if (e.type.kind !== "bool") err("unary ! must be bool", e.loc);
        }
        break;
      case "incDec": {
        // Expression-position ++/--: an f64 local or module global,
        // mutable, read-and-written in place.
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`incDec of undeclared local/global "${e.localId}"`, e.loc);
        else {
          if (!binding.mutable && locals.has(e.localId)) {
            err(`incDec of immutable local "${binding.name}"`, e.loc);
          }
          if (binding.type.kind !== "f64") {
            err(`incDec of non-f64 binding "${binding.name}" (${binding.type.kind})`, e.loc);
          }
        }
        if (e.type.kind !== "f64") err("incDec must be f64", e.loc);
        break;
      }
      case "fieldIncDec": {
        // Expression-position ++/-- over a class field: an f64 field, or a
        // dyn field with fieldDyn set (validated numeric read-modify-write).
        checkExpr(e.obj);
        const cls = classes.get(e.className);
        const field = cls?.fields.find((f) => f.name === e.field);
        if (!cls) err(`fieldIncDec on undeclared class "${e.className}"`, e.loc);
        else if (!field) err(`class ${e.className} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "object", className: e.className }, "fieldIncDec receiver");
          if (e.fieldDyn ? field.type.kind !== "dyn" : field.type.kind !== "f64") {
            err(`fieldIncDec ${e.className}.${e.field} field/flag mismatch (${field.type.kind})`, e.loc);
          }
        }
        if (e.type.kind !== "f64") err("fieldIncDec must be f64", e.loc);
        break;
      }
      case "assignExpr": {
        // Expression-position `x = e`: a mutable local or module global,
        // written with a value of its own type; the expression yields it.
        checkExpr(e.value);
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`assignExpr to undeclared local/global "${e.localId}"`, e.loc);
        else {
          if (!binding.mutable && locals.has(e.localId)) {
            err(`assignExpr to immutable local "${binding.name}"`, e.loc);
          }
          if (!typeEquals(binding.type, e.type)) {
            err(`assignExpr type must match binding "${binding.name}" (${binding.type.kind} vs ${e.type.kind})`, e.loc);
          }
        }
        if (!typeEquals(e.value.type, e.type)) {
          err(`assignExpr value type must match its own type`, e.loc);
        }
        break;
      }
      case "seqExpr": {
        // Statements in an expression: straight-line writes only — no
        // control flow, no jumps (the C emission point is mid-expression).
        const allowed = new Set(["varDecl", "assign", "exprStmt", "fieldSet", "recordSet", "recordKeySet", "arraySet", "bytesSet", "block"]);
        const flat = (ss: IrStmt[]): void => {
          for (const s of ss) {
            if (!allowed.has(s.kind)) {
              err(`seqExpr statement kind "${s.kind}" is not straight-line`, s.loc);
              continue;
            }
            if (s.kind === "block") {
              flat(s.body);
              continue;
            }
            checkStmt(s);
          }
        };
        flat(e.stmts);
        checkExpr(e.result);
        if (!typeEquals(e.result.type, e.type)) err(`seqExpr type must match its result`, e.loc);
        break;
      }
      case "dynDestrCheck": {
        checkExpr(e.value);
        if (e.value.type.kind !== "dyn" && e.value.type.kind !== "jsval") err("dynDestrCheck value must be dyn or jsval", e.loc);
        if (e.type.kind !== e.value.type.kind) err("dynDestrCheck must have its value's type", e.loc);
        break;
      }
      case "dynIterN": {
        checkExpr(e.value);
        if (e.value.type.kind !== "dyn" && e.value.type.kind !== "jsval") err("dynIterN value must be dyn or jsval", e.loc);
        if (e.type.kind !== e.value.type.kind) err("dynIterN must have its value's type", e.loc);
        if (!Number.isInteger(e.count) || e.count < 0) err("dynIterN count must be a non-negative integer", e.loc);
        break;
      }
      case "toBool":
        checkExpr(e.operand);
        if (
          e.operand.type.kind !== "f64" &&
          e.operand.type.kind !== "string" &&
          e.operand.type.kind !== "union" &&
          !REF_TRUTHY_KINDS.has(e.operand.type.kind)
        ) {
          err(`toBool operand must be f64|string|union|ref, got ${e.operand.type.kind}`, e.loc);
        }
        if (e.operand.type.kind === "union") checkTruthyUnion(e.operand.type.unionId, e.loc);
        if (e.type.kind !== "bool") err("toBool must be bool", e.loc);
        break;
      case "logical":
        checkExpr(e.left);
        checkExpr(e.right);
        if (
          e.type.kind !== "f64" && e.type.kind !== "string" && e.type.kind !== "bool" &&
          e.type.kind !== "jsval" && e.type.kind !== "union" && e.type.kind !== "dyn"
        ) {
          err(`logical ${e.op} must be f64|string|bool|jsval|union|dyn, got ${e.type.kind}`, e.loc);
        }
        if (e.type.kind === "union") checkTruthyUnion(e.type.unionId, e.loc);
        expectType(e.left, e.type, `logical ${e.op} left`);
        expectType(e.right, e.type, `logical ${e.op} right`);
        break;
      case "unionEq": {
        checkExpr(e.left);
        checkExpr(e.right);
        if (!unions.has(e.unionId)) err(`unionEq of unknown union ${e.unionId}`, e.loc);
        const ut: IrType = { kind: "union", unionId: e.unionId };
        expectType(e.left, ut, "unionEq left");
        expectType(e.right, ut, "unionEq right");
        if (e.type.kind !== "bool") err("unionEq must be bool", e.loc);
        break;
      }
      case "strConcat":
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.left, STRING, "strConcat left");
        expectType(e.right, STRING, "strConcat right");
        if (e.type.kind !== "string") err("strConcat must be string", e.loc);
        break;
      case "strEq":
      case "strCmp":
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.left, STRING, `${e.kind} left`);
        expectType(e.right, STRING, `${e.kind} right`);
        if (e.type.kind !== "bool") err(`${e.kind} must be bool`, e.loc);
        break;
      case "ternary":
        checkExpr(e.cond);
        checkExpr(e.then);
        checkExpr(e.else_);
        expectType(e.cond, BOOL, "ternary condition");
        expectType(e.then, e.type, "ternary then-branch");
        expectType(e.else_, e.type, "ternary else-branch");
        if (e.type.kind === "void") err("ternary must not be void", e.loc);
        break;
      case "optChain": {
        checkExpr(e.receiver);
        // An island-handle chain (`x?.y` on 'any'): the nullish test is a
        // runtime ask of the engine value; the body is the plain island
        // operation over the bound handle, and both body and result stay
        // jsval (the unit path is the engine's undefined).
        if (e.receiver.type.kind === "jsval") {
          if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
          activeChains.set(e.id, JSVAL);
          checkExpr(e.body);
          activeChains.delete(e.id);
          if (e.body.type.kind !== "jsval") {
            err(`jsval optChain with ${e.body.type.kind} body`, e.loc);
          }
          if (e.type.kind !== "jsval") {
            err(`jsval optChain must be jsval, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        // A dyn (dyn) chain (`rawName?.match(re)` on a JSON.parse result):
        // the nullish test reads the node's kind tag; the body is the
        // validated dynamic dispatch, its result converted back into the
        // dyn (dynFrom) — so body and result are dyn, or void for
        // statement-position chains.
        if (e.receiver.type.kind === "dyn") {
          if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
          activeChains.set(e.id, DYN);
          checkExpr(e.body);
          activeChains.delete(e.id);
          if (e.body.type.kind !== "dyn" && e.body.type.kind !== "void") {
            err(`dyn optChain with ${e.body.type.kind} body`, e.loc);
          }
          if (e.type.kind !== "dyn" && e.type.kind !== "void") {
            err(`dyn optChain must be dyn or void, got ${e.type.kind}`, e.loc);
          }
          if (e.type.kind === "void" && e.body.type.kind !== "void") {
            err(`void dyn optChain with ${e.body.type.kind} body`, e.loc);
          }
          break;
        }
        if (e.receiver.type.kind !== "union") {
          err(`optChain receiver must be a union, got ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const def = unions.get(e.receiver.type.unionId);
        if (!def) {
          err(`optChain receiver references unknown union ${e.receiver.type.unionId}`, e.loc);
          break;
        }
        const rest = def.arms.filter((a) => !isUnitType(a));
        if (rest.length !== 1 || rest.length === def.arms.length) {
          err("optChain receiver must have unit arms and exactly one non-unit arm", e.loc);
          break;
        }
        if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
        activeChains.set(e.id, rest[0]!);
        checkExpr(e.body);
        activeChains.delete(e.id);
        if (e.type.kind === "void") {
          if (e.body.type.kind !== "void") {
            err(`void optChain with ${e.body.type.kind} body`, e.loc);
          }
          break;
        }
        expectType(e.body, e.type, "optChain body");
        // dyn results carry the unit path as the undefined dyn value; every
        // other value result needs an undefined arm to land on.
        if (e.type.kind !== "dyn") {
          const rdef = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          if (!rdef || !rdef.arms.some((a) => a.kind === "undefinedT")) {
            err("optChain type must be void, dyn, or an undefined-armed union", e.loc);
          }
        }
        break;
      }
      case "chainRecv": {
        const bound = activeChains.get(e.id);
        if (!bound) {
          err(`chainRecv "${e.id}" outside its optChain body`, e.loc);
          break;
        }
        expectType(e, bound, "chainRecv");
        break;
      }
      case "nullish": {
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.right, e.type, "nullish right operand");
        // The ISLAND form: `a ?? b` over an engine value — left, right,
        // and result are all handles (the emitters' jsval nullish arm).
        if (e.left.type.kind === "jsval") {
          if (e.type.kind !== "jsval") err("jsval nullish must answer jsval", e.loc);
          break;
        }
        // The CHECKED-DYNAMIC form: the runtime kind decides (the
        // emitters' scr_dyn_is_nullish arm) — left, right, and result
        // all live in the checked-dynamic tree.
        if (e.left.type.kind === "dyn") {
          if (e.type.kind !== "dyn") err("dyn nullish must answer dyn", e.loc);
          break;
        }
        if (e.left.type.kind !== "union") {
          err(`nullish left must be a union, got ${e.left.type.kind}`, e.loc);
          break;
        }
        const def = unions.get(e.left.type.unionId);
        if (!def) {
          err(`nullish left references unknown union ${e.left.type.unionId}`, e.loc);
          break;
        }
        if (!def.arms.some(isUnitType)) {
          err("nullish left union has no unit arm (frontend must fence)", e.loc);
        }
        // Two shapes: pass-through (type === left's union) or narrowed
        // (type === the union's SINGLE non-unit arm).
        if (!typeEquals(e.type, e.left.type)) {
          const rest = def.arms.filter((a) => !isUnitType(a));
          if (rest.length !== 1 || !typeEquals(e.type, rest[0]!)) {
            err("nullish type must be the left union or its single non-unit arm", e.loc);
          }
        }
        break;
      }
      case "orDefault": {
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.right, e.type, "orDefault right operand");
        if (e.left.type.kind !== "union") {
          err(`orDefault left must be a union, got ${e.left.type.kind}`, e.loc);
          break;
        }
        const def = unions.get(e.left.type.unionId);
        if (!def) {
          err(`orDefault left references unknown union ${e.left.type.unionId}`, e.loc);
          break;
        }
        // Retagged shape: the truthy side is a call to the named helper, so
        // the arm count is free and the type rule is the helper's signature.
        if (e.retag !== undefined) {
          const helper = functions.get(e.retag);
          if (!helper) {
            err(`orDefault retag calls undeclared function "${e.retag}"`, e.loc);
          } else if (helper.params.length !== 1 || !typeEquals(helper.params[0]!.type, e.left.type)) {
            err(`orDefault retag ${e.retag} must take exactly the left union`, e.loc);
          } else if (!typeEquals(callSiteReturnType(helper), e.type)) {
            err(`orDefault retag ${e.retag} must return the node's type`, e.loc);
          }
          break;
        }
        const rest = def.arms.filter((a) => !isUnitType(a));
        if (rest.length !== 1 || !typeEquals(e.type, rest[0]!)) {
          err("orDefault type must be the left union's single non-unit arm", e.loc);
        }
        break;
      }
      case "toString":
        checkExpr(e.operand);
        if (e.operand.type.kind === "union") {
          // Union operands dispatch through the per-union ToString helper;
          // every arm needs a text (unit/string/f64/bool, plus the Buffer
          // arm whose toString IS the utf8 decode — the frontend fences
          // unions with other ref arms, where JS prints "[object Object]").
          const def = unions.get(e.operand.type.unionId);
          if (!def) {
            err(`toString of unknown union ${e.operand.type.unionId}`, e.loc);
          } else if (
            !def.arms.every(
              (a) =>
                a.kind === "undefinedT" || a.kind === "nullT" ||
                a.kind === "string" || a.kind === "f64" || a.kind === "bool" ||
                (a.kind === "bytes" && a.elem === "u8"),
            )
          ) {
            err("toString union operand has a non-stringable arm (frontend must fence)", e.loc);
          }
        } else if (
          e.operand.type.kind !== "f64" &&
          e.operand.type.kind !== "bool" &&
          e.operand.type.kind !== "caught" &&
          e.operand.type.kind !== "dyn" &&
          // Plain data records print Object.prototype.toString's constant
          // (tuples and toString-field shapes are fenced in the frontend).
          e.operand.type.kind !== "record"
        ) {
          err(`toString operand must be f64|bool|caught|dyn|record, got ${e.operand.type.kind}`, e.loc);
        }
        if (e.type.kind !== "string") err("toString must be string", e.loc);
        break;
      case "strIntrinsic": {
        checkExpr(e.receiver);
        expectType(e.receiver, STRING, `strIntrinsic ${e.method} receiver`);
        const sig = STR_INTRINSIC_SIGS[e.method];
        if (e.args.length < sig.minArgs || e.args.length > sig.argTypes.length) {
          const want =
            sig.minArgs === sig.argTypes.length
              ? `${sig.argTypes.length}`
              : `${sig.minArgs}-${sig.argTypes.length}`;
          err(`strIntrinsic ${e.method}: ${e.args.length} args, expected ${want}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `strIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`strIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "regexLit": {
        if (e.type.kind !== "regex") err("regexLit must be regex-typed", e.loc);
        if (!/^[gimsuy]*$/.test(e.flags)) {
          err(`regexLit flags "${e.flags}" outside the supported alphabet (gimsuy)`, e.loc);
        }
        if (new Set(e.flags).size !== e.flags.length) {
          err(`regexLit flags "${e.flags}" contain a duplicate`, e.loc);
        }
        break;
      }
      case "templateStrings": {
        if (e.type.kind !== "array" || e.type.elem.kind !== "string") {
          err("templateStrings must be string[]-typed", e.loc);
        }
        if (e.key === "") err("templateStrings key must be non-empty", e.loc);
        break;
      }
      case "regexIntrinsic": {
        checkExpr(e.receiver);
        const sig = REGEX_INTRINSIC_SIGS[e.method];
        expectType(e.receiver, sig.receiver, `regexIntrinsic ${e.method} receiver`);
        if (e.args.length !== sig.argTypes.length) {
          err(`regexIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `regexIntrinsic ${e.method} arg ${i}`);
        });
        if (e.method === "match") {
          // The `string[] | null` union (program-dependent id) — checked
          // by arms, like the libCall case checks process.envGet.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) err("regexIntrinsic match must be the string[] | null union", e.loc);
          break;
        }
        if (!typeEquals(e.type, sig.result)) {
          err(`regexIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "arrayLit": {
        if (e.type.kind !== "array") {
          err(`arrayLit must be array-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        const elem = e.type.elem;
        const spreadSet = new Set(e.spreads ?? []);
        for (const i of spreadSet) {
          if (!Number.isInteger(i) || i < 0 || i >= e.elems.length) {
            err(`arrayLit spread index ${i} out of range`, e.loc);
          }
        }
        e.elems.forEach((el, i) => {
          checkExpr(el);
          // Spread positions hold a same-typed ARRAY (copied element-wise);
          // plain positions hold one element.
          expectType(el, spreadSet.has(i) ? e.type : elem, `arrayLit element ${i}`);
        });
        break;
      }
      case "arrayNewLen": {
        // Mapper-less Array.from({length: n}): absent-slot fill exists
        // only for refcounted element kinds (frontend fences scalars).
        if (e.type.kind !== "array") {
          err(`arrayNewLen must be array-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (!isRefCounted(e.type.elem)) {
          err(`arrayNewLen with non-refcounted ${e.type.elem.kind} elements (no absent value)`, e.loc);
        }
        checkExpr(e.length);
        expectType(e.length, F64, "arrayNewLen length");
        break;
      }
      case "arrayGet": {
        checkExpr(e.arr);
        checkExpr(e.index);
        expectType(e.index, F64, "arrayGet index");
        if (e.arr.type.kind !== "array") {
          err(`arrayGet on non-array ${e.arr.type.kind}`, e.loc);
        } else if (!typeEquals(e.type, e.arr.type.elem)) {
          err(`arrayGet result ${e.type.kind} != element ${e.arr.type.elem.kind}`, e.loc);
        }
        break;
      }
      case "bytesNew": {
        if (e.type.kind !== "bytes") {
          err(`bytesNew of non-bytes type ${e.type.kind}`, e.loc);
          break;
        }
        if (e.source) {
          checkExpr(e.source);
          const sk = e.source.type;
          if (sk.kind === "bytes") {
            // Same-elem copies only (cross-kind construction is fenced).
            if (!typeEquals(sk, e.type)) {
              err(`bytesNew copy source elem mismatch`, e.loc);
            }
          } else if (sk.kind === "array") {
            if (sk.elem.kind !== "f64") {
              err(`bytesNew array source must hold f64, got ${sk.elem.kind}`, e.loc);
            }
          } else if (sk.kind !== "f64") {
            err(`bytesNew source of kind ${sk.kind}`, e.loc);
          }
        }
        break;
      }
      case "bytesIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "bytes") {
          err(`bytesIntrinsic ${e.method} on non-bytes ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const recv = e.receiver.type;
        // The dvGet* getters read through a DataView — always a bytes<u8>
        // view; dataViewNew and byteOffset take ANY elem kind (views form
        // over any typed array's storage, owners answer byteOffset 0).
        const isDvGet = e.method.startsWith("dvGet");
        const isNum =
          e.method === "readNum" || e.method === "writeNum" || e.method === "readNumVar" || e.method === "writeNumVar";
        const U8_ONLY_EXTRA: ReadonlySet<string> = new Set([
          "toString", "toStringVar", "equals", "compareBuf", "indexOf", "lastIndexOf", "includes",
          "indexOfNum", "lastIndexOfNum", "includesNum", "fill", "fillNum", "fillStr",
          "copy", "swap16", "swap32", "swap64", "writeStr",
        ]);
        const u8Only = U8_ONLY_EXTRA.has(e.method) || isNum || isDvGet;
        if (u8Only && recv.elem !== "u8") {
          err(`bytesIntrinsic ${e.method} on a ${recv.elem} receiver (u8 only)`, e.loc);
        }
        // The numeric families' kind rides as args[0] — ALWAYS a string
        // literal (the backend maps it to the runtime tag at compile
        // time; a runtime-valued kind has no meaning).
        if (isNum && e.args[0]?.kind !== "strLit") {
          err(`bytesIntrinsic ${e.method} args[0] must be a strLit kind token`, e.loc);
        }
        // fillStr/writeStr carry their NORMALIZED encoding as args[1],
        // always a strLit (the frontend folds the aliases).
        if ((e.method === "fillStr" || e.method === "writeStr") && e.args[1]?.kind !== "strLit") {
          err(`bytesIntrinsic ${e.method} args[1] must be a strLit encoding`, e.loc);
        }
        const EXTRA_SIGS: Record<string, { argTypes: IrType[]; minArgs: number; result: IrType } | undefined> = {
          equals: { argTypes: [BYTES_U8], minArgs: 1, result: BOOL },
          compareBuf: { argTypes: [BYTES_U8, F64, F64, F64, F64], minArgs: 1, result: F64 },
          // [needle, align, byteOffset?] — an OMITTED byteOffset is Node's
          // search-everything default (the backend passes NaN).
          indexOf: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: F64 },
          lastIndexOf: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: F64 },
          includes: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: BOOL },
          indexOfNum: { argTypes: [F64, F64], minArgs: 1, result: F64 },
          lastIndexOfNum: { argTypes: [F64, F64], minArgs: 1, result: F64 },
          includesNum: { argTypes: [F64, F64], minArgs: 1, result: BOOL },
          fill: { argTypes: [BYTES_U8, F64, F64], minArgs: 1, result: BYTES_U8 },
          fillNum: { argTypes: [F64, F64, F64], minArgs: 1, result: BYTES_U8 },
          // Per-element TypedArray fill (any elem — the non-u8 fill path).
          fillElem: { argTypes: [F64, F64, F64], minArgs: 1, result: bytesOf(recv.elem) },
          fillStr: { argTypes: [STRING, STRING, F64, F64], minArgs: 2, result: BYTES_U8 },
          copy: { argTypes: [BYTES_U8, F64, F64, F64], minArgs: 1, result: F64 },
          swap16: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          swap32: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          swap64: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          writeStr: { argTypes: [STRING, STRING, F64, F64], minArgs: 3, result: F64 },
        };
        // Object.hasOwn: "toString" is a real method name here and must
        // not answer from Object.prototype.
        const extraSig = Object.hasOwn(EXTRA_SIGS, e.method) ? EXTRA_SIGS[e.method] : undefined;
        const sig: { argTypes: IrType[]; minArgs: number; result: IrType } = extraSig ?? (
          e.method === "length" || e.method === "byteLength" || e.method === "byteOffset"
            ? { argTypes: [], minArgs: 0, result: F64 }
            : e.method === "get"
              ? { argTypes: [F64], minArgs: 1, result: F64 }
              : e.method === "slice" || e.method === "subarray"
                ? { argTypes: [F64, F64], minArgs: 0, result: bytesOf(recv.elem) }
                : e.method === "toReversed"
                  ? { argTypes: [], minArgs: 0, result: bytesOf(recv.elem) }
                : e.method === "with"
                  ? { argTypes: [F64, F64], minArgs: 2, result: bytesOf(recv.elem) }
                  : e.method === "join"
                    ? { argTypes: [STRING], minArgs: 1, result: STRING }
                    : e.method === "toArray"
                      ? { argTypes: [], minArgs: 0, result: arrayOf(F64) }
                : e.method === "setFrom"
                  ? { argTypes: [bytesOf(recv.elem), F64], minArgs: 1, result: VOID }
                  : e.method === "toString" || e.method === "toStringVar"
                    ? { argTypes: [STRING, F64, F64], minArgs: 1, result: STRING }
                    : e.method === "readNum"
                      ? { argTypes: [STRING, F64], minArgs: 2, result: F64 }
                      : e.method === "writeNum"
                        ? { argTypes: [STRING, F64, F64], minArgs: 3, result: F64 }
                        : e.method === "readNumVar"
                          ? { argTypes: [STRING, F64, F64], minArgs: 3, result: F64 }
                          : e.method === "writeNumVar"
                            ? { argTypes: [STRING, F64, F64, F64], minArgs: 4, result: F64 }
                            : e.method === "dataViewNew"
                              ? { argTypes: [F64, F64], minArgs: 0, result: BYTES_U8 }
                              : e.method.startsWith("dvSet")
                                ? {
                                    // dvSet*: [offset, value], the 8-bit setters take no littleEndian.
                                    argTypes:
                                      e.method === "dvSetUint8" || e.method === "dvSetInt8"
                                        ? [F64, F64]
                                        : [F64, F64, BOOL],
                                    minArgs: 2,
                                    result: VOID,
                                  }
                                : {
                                    // dvGet*: the 8-bit getters take no littleEndian.
                                    argTypes:
                                      e.method === "dvGetUint8" || e.method === "dvGetInt8" ? [F64] : [F64, BOOL],
                                    minArgs: 1,
                                    result: F64,
                                  });
        if (e.args.length < sig.minArgs || e.args.length > sig.argTypes.length) {
          err(`bytesIntrinsic ${e.method}: ${e.args.length} args`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `bytesIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`bytesIntrinsic ${e.method} result must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "arrIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "array") {
          err(`arrIntrinsic ${e.method} on non-array ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const elem = e.receiver.type.elem;
        const sig =
          e.method === "push" || e.method === "unshift"
            ? { argTypes: e.args.map(() => elem), result: F64 }
            : e.method === "pushSpread" || e.method === "unshiftSpread"
              ? { argTypes: [e.receiver.type], result: F64 }
              : e.method === "pop"
              ? { argTypes: [], result: elem }
              : e.method === "indexOf"
                ? { argTypes: [elem], result: F64 }
                : e.method === "includes"
                  ? { argTypes: [elem], result: BOOL }
                  : e.method === "join"
                    ? { argTypes: [STRING], result: STRING }
                : e.method === "slice"
                  ? { argTypes: [F64, F64], result: e.receiver.type }
                  : e.method === "toReversed"
                    ? { argTypes: [], result: e.receiver.type }
                    : e.method === "reverse"
                      ? { argTypes: [], result: e.receiver.type }
                    : e.method === "toSpliced"
                      ? { argTypes: [F64, F64, e.receiver.type], result: e.receiver.type }
                      : e.method === "with"
                        ? { argTypes: [F64, elem], result: e.receiver.type }
                  : e.method === "splice"
                    ? { argTypes: [F64, F64], result: e.receiver.type }
                        : e.method === "shift"
                          ? { argTypes: [], result: e.type } // union-checked below
                          : { argTypes: [], result: F64 }; // length
        if (
          e.method === "join" &&
          elem.kind !== "f64" && elem.kind !== "string" && elem.kind !== "bool" &&
          !(
            elem.kind === "union" &&
            (unions
              .get(elem.unionId)
              ?.arms.every(
                (a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
              ) ??
              false)
          )
        ) {
          err(`arrIntrinsic join on ${elem.kind} elements (frontend must reject)`, e.loc);
        }
        if ((e.method === "indexOf" || e.method === "includes") && elem.kind === "union") {
          // Union boxes are compiler artifacts — pointer identity would
          // misjudge JS ===; the frontend fences these.
          err(`arrIntrinsic ${e.method} on union elements (frontend must reject)`, e.loc);
        }
        if (e.method === "shift") {
          // The result is the interned `elem | undefined` union (union
          // elements are frontend-fenced, so the arms never collide).
          if (elem.kind === "union") {
            err("arrIntrinsic shift on union elements (frontend must reject)", e.loc);
          }
          const rdef = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          if (
            !rdef ||
            !rdef.arms.some((a) => a.kind === "undefinedT") ||
            !rdef.arms.some((a) => typeEquals(a, elem))
          ) {
            err("arrIntrinsic shift result must be the elem|undefined union", e.loc);
          }
        }
        // slice's indices and splice's count are optional (omitted args
        // omitted from the IR — backends fill the defaults); everything
        // else is exact.
        const minArgs = e.method === "slice" ? 0 : e.method === "splice" ? 1 : sig.argTypes.length;
        if (e.args.length < minArgs || e.args.length > sig.argTypes.length) {
          err(`arrIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `arrIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`arrIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "mapNew": {
        if (e.type.kind !== "map") {
          err(`mapNew must be map-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (!isSupportedMapKey(e.type.key)) {
          err(`mapNew key kind ${e.type.key.kind} (frontend must fence)`, e.loc);
        }
        if (!isSupportedMapValue(e.type.value)) {
          err(`mapNew value kind ${e.type.value.kind} (frontend must fence)`, e.loc);
        }
        // Seed entries lower pairwise, K/V-typed exactly like set() args.
        for (const pair of e.seed ?? []) {
          checkExpr(pair.key);
          expectType(pair.key, e.type.key, "mapNew seed key");
          checkExpr(pair.value);
          expectType(pair.value, e.type.value, "mapNew seed value");
        }
        break;
      }
      case "mapIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "map") {
          err(`mapIntrinsic ${e.method} on non-map ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const { key, value } = e.receiver.type;
        if (e.method === "get") {
          // Result is the interned `V | undefined` union: an undefined arm
          // must exist, and every OTHER arm must be V (V non-union) or one
          // of V's arms IN ORDER (V union — `undefined` sorts last in
          // canonical arm order, so tags coincide and the backend can hand
          // the stored box straight through).
          if (e.args.length !== 1) {
            err(`mapIntrinsic get: ${e.args.length} args, expected 1`, e.loc);
            break;
          }
          checkExpr(e.args[0]!);
          expectType(e.args[0]!, key, "mapIntrinsic get key");
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const rest = def ? def.arms.filter((a) => a.kind !== "undefinedT") : [];
          // When V is itself a union its own undefined arm (if any) folds
          // into the result's — compare the non-undefined arms pairwise.
          const varms =
            value.kind === "union"
              ? (unions.get(value.unionId)?.arms ?? []).filter((a) => a.kind !== "undefinedT")
              : [value];
          const ok =
            def &&
            rest.length === def.arms.length - 1 &&
            def.arms[def.arms.length - 1]!.kind === "undefinedT" &&
            rest.length === varms.length &&
            rest.every((a, i) => typeEquals(a, varms[i]!));
          if (!ok) {
            err(`mapIntrinsic get must return the 'V | undefined' union`, e.loc);
          }
          break;
        }
        const sig =
          e.method === "set"
            ? { argTypes: [key, value], result: VOID }
            : e.method === "has" || e.method === "delete"
              ? { argTypes: [key], result: BOOL }
              : e.method === "clear" || e.method === "iterEnter" || e.method === "iterExit"
                ? { argTypes: [], result: VOID }
                : e.method === "iterLive"
                  ? { argTypes: [F64], result: BOOL }
                  : e.method === "iterKey"
                    ? { argTypes: [F64], result: key }
                    : e.method === "iterValue"
                      ? { argTypes: [F64], result: value }
                      : { argTypes: [], result: F64 }; // size / iterCount
        if (e.args.length !== sig.argTypes.length) {
          err(`mapIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `mapIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`mapIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "setNew": {
        if (e.type.kind !== "set") {
          err(`setNew must be set-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (!isSupportedSetElem(e.type.elem)) {
          err(`setNew element kind ${e.type.elem.kind} (frontend must fence)`, e.loc);
        }
        // The seed is one T[]-typed expression (T = the element type).
        if (e.seed) {
          checkExpr(e.seed);
          expectType(e.seed, arrayOf(e.type.elem), "setNew seed");
        }
        break;
      }
      case "setIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "set") {
          err(`setIntrinsic ${e.method} on non-set ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const { elem } = e.receiver.type;
        const sig =
          e.method === "add"
            ? { argTypes: [elem], result: VOID }
            : e.method === "has" || e.method === "delete"
              ? { argTypes: [elem], result: BOOL }
              : e.method === "clear" || e.method === "iterEnter" || e.method === "iterExit"
                ? { argTypes: [], result: VOID }
                : e.method === "iterLive"
                  ? { argTypes: [F64], result: BOOL }
                  : e.method === "iterKey"
                    ? { argTypes: [F64], result: elem }
                    : e.method === "toArray"
                      ? { argTypes: [], result: arrayOf(elem) }
                      : { argTypes: [], result: F64 }; // size / iterCount
        if (e.args.length !== sig.argTypes.length) {
          err(`setIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `setIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`setIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "call": {
        for (const a of e.args) checkExpr(a);
        const callee = functions.get(e.callee);
        if (!callee) {
          err(`call to undeclared function "${e.callee}"`, e.loc);
          break;
        }
        if (callee.params.length !== e.args.length) {
          err(`call ${e.callee}: ${e.args.length} args, expected ${callee.params.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = callee.params[i];
          if (p) expectType(a, p.type, `call ${e.callee} arg ${i}`);
        });
        const expected = callSiteReturnType(callee);
        if (!typeEquals(e.type, expected)) {
          err(`call ${e.callee} type ${e.type.kind} != return ${expected.kind}`, e.loc);
        }
        break;
      }
      case "ffiCall": {
        for (const arg of e.args) checkExpr(arg);
        const entry = ffiByName.get(e.import);
        if (!entry) {
          err(`FFI call to undeclared import "${e.import}"`, e.loc);
          break;
        }
        const sourceParamTypes = ffiSourceParamTypes(entry.params);
        if (sourceParamTypes.length !== e.args.length) {
          err(
            `FFI call ${e.import}: ${e.args.length} args, expected ${sourceParamTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((arg, i) => {
          const expectedParam = sourceParamTypes[i];
          if (expectedParam !== undefined) {
            expectType(arg, expectedParam, `FFI call ${e.import} arg ${i}`);
          }
        });
        const expected = ffiClassType(entry.returns);
        if (!typeEquals(e.type, expected)) {
          err(
            `FFI call ${e.import} type ${e.type.kind} != return class ${entry.returns}`,
            e.loc,
          );
        }
        break;
      }
      case "closure": {
        const target = functions.get(e.fnName);
        if (!target) {
          err(`closure over undeclared function "${e.fnName}"`, e.loc);
          break;
        }
        if (e.type.kind !== "func") {
          err("closure must have func type", e.loc);
          break;
        }
        const wantCaps = target.captures ?? [];
        if (target.captures === undefined && e.captures.length > 0) {
          err(`closure over plain function "${e.fnName}" cannot capture`, e.loc);
        }
        if (e.captures.length !== wantCaps.length) {
          err(`closure ${e.fnName}: ${e.captures.length} captures, expected ${wantCaps.length}`, e.loc);
        }
        e.captures.forEach((id, i) => {
          const local = locals.get(id);
          const want = wantCaps[i];
          if (!local) err(`closure capture of undeclared local "${id}"`, e.loc);
          else if (!local.boxed) err(`closure capture "${id}" is not boxed`, e.loc);
          else if (want && !typeEquals(local.type, want.type)) {
            err(`closure capture "${id}" type ${local.type.kind} != ${want.type.kind}`, e.loc);
          }
        });
        // Result func type must match the target's signature. A VARIADIC
        // (rest-marked) type hides one synthetic trailing dyn-array param
        // in the lifted function (the thunk fills it) — the type's
        // declared params plus that one must match.
        if (e.type.kind === "func") {
          const wantRet = callSiteReturnType(target);
          // ISLAND-REST types (restAbi jsval) SPELL their trailing engine
          // array param — the lifted signature matches directly, no
          // hidden slot.
          const hiddenRest = e.type.rest === true && e.type.restAbi !== "jsval";
          const declared = hiddenRest ? target.params.slice(0, -1) : target.params;
          const restOk =
            !hiddenRest ||
            (target.params.length === e.type.params.length + 1 &&
              target.params[target.params.length - 1]!.type.kind === "dyn");
          if (
            !restOk ||
            e.type.params.length !== declared.length ||
            !e.type.params.every((p, i) => typeEquals(p, declared[i]!.type)) ||
            !typeEquals(e.type.ret, wantRet)
          ) {
            err(`closure ${e.fnName}: func type does not match target signature`, e.loc);
          }
        }
        break;
      }
      case "callValue": {
        checkExpr(e.callee);
        for (const a of e.args) checkExpr(a);
        if (e.callee.type.kind !== "func") {
          err(`callValue callee is ${e.callee.type.kind}, not func`, e.loc);
          break;
        }
        const ft = e.callee.type;
        if (ft.params.length !== e.args.length) {
          err(`callValue: ${e.args.length} args, expected ${ft.params.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = ft.params[i];
          if (p) expectType(a, p, `callValue arg ${i}`);
        });
        if (!typeEquals(e.type, ft.ret)) {
          err(`callValue type ${e.type.kind} != return ${ft.ret.kind}`, e.loc);
        }
        break;
      }
      case "selfRef":
        if (fn.captures === undefined) {
          err("selfRef outside a lifted function", e.loc);
        }
        if (e.type.kind !== "func") err("selfRef must have func type", e.loc);
        break;
      case "new": {
        for (const a of e.args) checkExpr(a);
        const cls = classes.get(e.className);
        if (!cls) {
          err(`new of undeclared class "${e.className}"`, e.loc);
          break;
        }
        const ctor = functions.get(`%${e.className}.constructor`);
        if (!ctor) {
          err(`new ${e.className}: missing constructor function`, e.loc);
          break;
        }
        // arg 0 is `this` (supplied by the new expr itself)
        if (ctor.params.length !== e.args.length + 1) {
          err(`new ${e.className}: ${e.args.length} args, ctor expects ${ctor.params.length - 1}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = ctor.params[i + 1];
          if (p) expectType(a, p.type, `new ${e.className} arg ${i}`);
        });
        if (!typeEquals(e.type, { kind: "object", className: e.className })) {
          err(`new ${e.className} must have that object type`, e.loc);
        }
        break;
      }
      case "fieldGet": {
        checkExpr(e.obj);
        const cls = classes.get(e.className);
        const field = cls?.fields.find((f) => f.name === e.field);
        if (!cls) err(`fieldGet on undeclared class "${e.className}"`, e.loc);
        else if (!field) err(`class ${e.className} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "object", className: e.className }, "fieldGet receiver");
          if (!typeEquals(e.type, field.type)) {
            err(`fieldGet ${e.className}.${e.field} type mismatch`, e.loc);
          }
        }
        break;
      }
      case "promiseVoidWiden": {
        // A promise value flowing into a VOID-promise slot: one C
        // representation, type-only — sound for every inner (awaiting
        // through the slot ignores the fulfillment payload).
        checkExpr(e.value);
        if (e.value.type.kind !== "promise") {
          err("promiseVoidWiden over a non-promise operand", e.loc);
        }
        if (e.type.kind !== "promise" || e.type.inner.kind !== "void") {
          err("promiseVoidWiden must be promise<void>-typed", e.loc);
        }
        break;
      }
      case "upcast":
      case "downcast": {
        // A pointer reinterpret is sound exactly between hierarchy
        // relatives: upcast widens a STRICT descendant to an ancestor,
        // downcast (checker-trusted) narrows an ancestor to a STRICT
        // descendant. Upcast additionally widens CLASS VALUES
        // (classval:D → classval:C): the same pointer, type-only — legal
        // exactly when D strictly descends from C AND the two completed
        // constructor ABIs agree (what newValue completion rests on).
        checkExpr(e.value);
        if (e.kind === "upcast" && e.type.kind === "classval" && e.value.type.kind === "classval") {
          const [sub, sup] = [e.value.type.className, e.type.className];
          if (!isStrictSubclass(sub, sup)) {
            err(`upcast: "${sub}" does not extend "${sup}"`, e.loc);
            break;
          }
          const subCtor = functions.get(`%${sub}.constructor`);
          const supCtor = functions.get(`%${sup}.constructor`);
          if (!subCtor || !supCtor) {
            err(`classval upcast: "${sub}"/"${sup}" lack constructor functions`, e.loc);
            break;
          }
          const abiEqual =
            subCtor.params.length === supCtor.params.length &&
            subCtor.params.every((p, i) => i === 0 || typeEquals(p.type, supCtor.params[i]!.type));
          if (!abiEqual) {
            err(`classval upcast: "${sub}" and "${sup}" constructor ABIs differ`, e.loc);
          }
          break;
        }
        if (e.type.kind !== "object" || e.value.type.kind !== "object") {
          err(`${e.kind} between non-class types`, e.loc);
          break;
        }
        const [sub, sup] =
          e.kind === "upcast"
            ? [e.value.type.className, e.type.className]
            : [e.type.className, e.value.type.className];
        if (!isStrictSubclass(sub, sup)) {
          err(`${e.kind}: "${sub}" does not extend "${sup}"`, e.loc);
        }
        break;
      }
      case "classRef": {
        const cls = classes.get(e.className);
        if (!cls) {
          err(`classRef to undeclared class "${e.className}"`, e.loc);
          break;
        }
        if (cls.runtime) {
          err(`classRef to runtime-provided class "${e.className}"`, e.loc);
        }
        if (cls.jsName === undefined) {
          err(`classRef to "${e.className}" without a jsName (the class object's .name)`, e.loc);
        }
        // A class value can always be constructed through — the frontend
        // notes the constructor edge at every classRef, so the emitted
        // thunk has a body to call.
        if (!functions.has(`%${e.className}.constructor`)) {
          err(`classRef to "${e.className}" without its constructor function`, e.loc);
        }
        if (!typeEquals(e.type, { kind: "classval", className: e.className })) {
          err(`classRef to "${e.className}" must have that classval type`, e.loc);
        }
        break;
      }
      case "newValue": {
        checkExpr(e.callee);
        for (const a of e.args) checkExpr(a);
        if (e.callee.type.kind !== "classval") {
          err(`newValue callee must be a class value, got ${e.callee.type.kind}`, e.loc);
          break;
        }
        const cls = e.callee.type.className;
        const ctor = functions.get(`%${cls}.constructor`);
        if (!ctor) {
          err(`newValue on "${cls}": missing constructor function`, e.loc);
          break;
        }
        // Count-exact against the static class's completed ABI (every
        // value legally in the slot shares it — the upcast rule).
        if (ctor.params.length !== e.args.length + 1) {
          err(`newValue on "${cls}": ${e.args.length} args, ctor expects ${ctor.params.length - 1}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = ctor.params[i + 1];
          if (p) expectType(a, p.type, `newValue on "${cls}" arg ${i}`);
        });
        if (!typeEquals(e.type, { kind: "object", className: cls })) {
          err(`newValue on "${cls}" must have that object type`, e.loc);
        }
        break;
      }
      case "instanceOfValue": {
        checkExpr(e.value);
        checkExpr(e.classValue);
        if (e.type.kind !== "bool") err("instanceOfValue must be bool", e.loc);
        if (e.classValue.type.kind !== "classval") {
          err(`instanceOfValue target must be a class value, got ${e.classValue.type.kind}`, e.loc);
          break;
        }
        // Both sides must be hierarchy members: the operand needs a vt
        // word to read; a standalone target class has one possible value
        // and the frontend folds it statically.
        if (!hierarchy.has(e.classValue.type.className)) {
          err(`instanceOfValue against standalone class "${e.classValue.type.className}"`, e.loc);
        }
        if (e.value.type.kind !== "object" || !hierarchy.has(e.value.type.className)) {
          err("instanceOfValue operand is not a hierarchy class instance", e.loc);
        }
        break;
      }
      case "instanceOf": {
        checkExpr(e.value);
        if (e.type.kind !== "bool") err("instanceOf must be bool", e.loc);
        if (!hierarchy.has(e.className)) {
          err(`instanceOf against non-hierarchy class "${e.className}"`, e.loc);
        }
        if (e.value.type.kind !== "object" || !hierarchy.has(e.value.type.className)) {
          err("instanceOf operand is not a hierarchy class instance", e.loc);
        }
        break;
      }
      case "virtualCall": {
        // args[0] is the receiver, typed exactly as the static class; the
        // call is well-formed against the NEAREST declaration at/above it,
        // and dynamic dispatch must be reachable: some strict descendant
        // overrides the method (otherwise the frontend devirtualizes).
        for (const a of e.args) checkExpr(a);
        const recv = e.args[0];
        if (!recv || !typeEquals(recv.type, { kind: "object", className: e.className })) {
          err(`virtualCall receiver must be object:${e.className}`, e.loc);
          break;
        }
        // The nearest declaration may be ABSTRACT (no function): the call
        // is then well-formed against any concrete override below — the
        // frontend's override-exactness rule makes every implementation
        // ABI-identical, so any one of them carries the slot's signature.
        let declared = false;
        let impl: IrFunction | undefined;
        for (let c = classes.get(e.className); c; c = c.base !== undefined ? classes.get(c.base) : undefined) {
          if (c.methods?.includes(e.method)) {
            declared = true;
            if (!c.abstractMethods?.includes(e.method)) {
              impl = functions.get(`%${c.name}.${e.method}`);
              break;
            }
          }
        }
        if (!declared) {
          err(`virtualCall ${e.className}.${e.method}: no declaration on the base chain`, e.loc);
          break;
        }
        const concreteBelow = [...classes.values()].filter(
          (c) =>
            c.methods?.includes(e.method) &&
            !c.abstractMethods?.includes(e.method) &&
            isStrictSubclass(c.name, e.className),
        );
        if (concreteBelow.length === 0) {
          err(`virtualCall ${e.className}.${e.method}: no concrete override below the static class`, e.loc);
        }
        impl ??= concreteBelow
          .map((c) => functions.get(`%${c.name}.${e.method}`))
          .find((f) => f !== undefined);
        if (!impl) {
          err(`virtualCall ${e.className}.${e.method}: no implementation function exists`, e.loc);
          break;
        }
        if (impl.params.length !== e.args.length) {
          err(`virtualCall ${e.className}.${e.method}: ${e.args.length} args, method expects ${impl.params.length}`, e.loc);
        }
        e.args.slice(1).forEach((a, i) => {
          const p = impl.params[i + 1];
          if (p) expectType(a, p.type, `virtualCall ${e.className}.${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, callSiteReturnType(impl))) {
          err(`virtualCall ${e.className}.${e.method} result type mismatch`, e.loc);
        }
        break;
      }
      case "recordLit": {
        if (e.type.kind !== "record") {
          err(`recordLit must be record-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        const shape = records.get(e.type.shapeId);
        if (!shape) {
          err(`recordLit of undeclared shape "${e.type.shapeId}"`, e.loc);
          break;
        }
        const want = new Map(shape.fields.map((f) => [f.name, f.type]));
        const seen = new Set<string>();
        for (const f of e.fields) {
          checkExpr(f.value);
          if (seen.has(f.name)) err(`recordLit initializes field "${f.name}" twice`, e.loc);
          seen.add(f.name);
          if (f.drop) {
            // A mapping-dropped field (the PromiseSettledResult honest
            // subset): evaluated, never stored — it must NOT name a
            // declared field (that would silently drop a real store),
            // and its value may be any type, void included.
            if (f.overflow) err(`recordLit drop entry "${f.name}" flagged overflow too`, e.loc);
            if (want.has(f.name)) {
              err(`recordLit drop entry "${f.name}" shadows a declared field of shape ${shape.id}`, e.loc);
            }
            continue;
          }
          if (f.overflow) {
            // Overflow entries exist only on index-signature shapes, name
            // no declared field, and carry the index-value type exactly
            // (the frontend converts/coerces before constructing).
            if (!shape.indexValue) {
              err(`recordLit overflow entry "${f.name}" on non-index-signature shape ${shape.id}`, e.loc);
            } else if (want.has(f.name)) {
              err(`recordLit overflow entry "${f.name}" shadows a declared field`, e.loc);
            } else {
              expectType(f.value, shape.indexValue, `recordLit overflow entry "${f.name}"`);
            }
            continue;
          }
          const ft = want.get(f.name);
          if (!ft) err(`shape ${shape.id} has no field "${f.name}"`, e.loc);
          else expectType(f.value, ft, `recordLit field "${f.name}"`);
        }
        if (e.fields.filter((f) => !f.overflow && !f.drop).length !== shape.fields.length) {
          err(`recordLit does not initialize every field of shape ${shape.id}`, e.loc);
        }
        break;
      }
      case "recordGet": {
        checkExpr(e.obj);
        const shape = records.get(e.shapeId);
        const field = shape?.fields.find((f) => f.name === e.field);
        if (!shape) err(`recordGet on undeclared shape "${e.shapeId}"`, e.loc);
        else if (!field) err(`shape ${e.shapeId} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordGet receiver");
          if (!typeEquals(e.type, field.type)) {
            err(`recordGet ${e.shapeId}.${e.field} type mismatch`, e.loc);
          }
        }
        break;
      }
      case "recordKeyGet": {
        checkExpr(e.obj);
        checkExpr(e.key);
        const shape = records.get(e.shapeId);
        if (!shape) {
          err(`recordKeyGet on undeclared shape "${e.shapeId}"`, e.loc);
          break;
        }
        if (shape.tuple) err(`recordKeyGet on tuple shape ${e.shapeId}`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordKeyGet receiver");
        expectType(e.key, STRING, "recordKeyGet key");
        // Every reachable value must SURFACE as the result type: identity,
        // an arm of a union result, or (dyn results) a dyn conversion —
        // the frontend's recordKeyResultOk mirror. overflowOnly reads (a
        // literal key naming no declared field) skip the declared check
        // and require the overflow to exist.
        const surfaces = (t: IrType): boolean =>
          typeEquals(t, e.type) ||
          (e.type.kind === "union" &&
            (unions.get(e.type.unionId)?.arms.some((a) => typeEquals(a, t)) ?? false)) ||
          e.type.kind === "dyn";
        if (e.overflowOnly && !shape.indexValue) {
          err(`recordKeyGet on ${e.shapeId}: overflowOnly read of a shape without an index signature`, e.loc);
        }
        if (!e.overflowOnly && !shape.fields.every((f) => surfaces(f.type))) {
          err(`recordKeyGet on ${e.shapeId}: a declared field cannot surface as the result type`, e.loc);
        }
        if (e.type.kind === "dyn" && shape.indexValue && shape.indexValue.kind !== "dyn") {
          err(`recordKeyGet on ${e.shapeId}: dyn result over a non-dyn index value`, e.loc);
        }
        if (shape.indexValue && e.type.kind !== "dyn" && !surfaces(shape.indexValue)) {
          err(`recordKeyGet on ${e.shapeId}: the overflow value cannot surface as the result type`, e.loc);
        }
        break;
      }
      case "recordOvfKeys": {
        checkExpr(e.obj);
        const shape = records.get(e.shapeId);
        if (!shape) {
          err(`recordOvfKeys on undeclared shape "${e.shapeId}"`, e.loc);
          break;
        }
        if (!shape.indexValue) err(`recordOvfKeys on ${e.shapeId}: no index signature`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordOvfKeys receiver");
        if (e.type.kind !== "array" || e.type.elem.kind !== "string") {
          err("recordOvfKeys must be string[]", e.loc);
        }
        break;
      }
      case "dynFrom": {
        if (e.type.kind !== "dyn") err(`dynFrom must be dyn-typed, got ${e.type.kind}`, e.loc);
        // A bare unit literal is legal exactly here (like unionWrap): the
        // dyn has first-class undefined/null values.
        if (e.value.kind === "unitLit") {
          const want = e.value.unit === "undefined" ? "undefinedT" : "nullT";
          if (e.value.type.kind !== want) {
            err(`unitLit '${e.value.unit}' typed ${e.value.type.kind}`, e.loc);
          }
          break;
        }
        checkExpr(e.value);
        // Domain: JSON-safe, bytes<u8> (the checked-dynamic tree's bytes kind — payload
        // copied), an undefined-armed union of JSON-safe arms (the
        // undefined arm becomes the undefined dyn value), or a BOXABLE
        // function type (the checked-dynamic tree's function kind — canConvertToDyn folds
        // all four in).
        const vt = e.value.type;
        if (!canConvertToDyn(vt, (id) => records.get(id), (id) => unions.get(id))) {
          err(`dynFrom of non-dyn-convertible type ${vt.kind}`, e.loc);
        }
        if (e.liveRef && !liveDynRefEligible(vt)) {
          err(`live dynFrom of unsupported type ${vt.kind}`, e.loc);
        }
        break;
      }
      case "dynFromJsval": {
        // The jsval→dyn crossing: exactly a jsval operand into a dyn
        // result (the by-reference island wrap; scalars normalize at
        // runtime).
        checkExpr(e.value);
        if (e.type.kind !== "dyn") err(`dynFromJsval must be dyn-typed, got ${e.type.kind}`, e.loc);
        if (e.value.type.kind !== "jsval") {
          err(`dynFromJsval operand must be jsval, got ${e.value.type.kind}`, e.loc);
        }
        break;
      }
      case "dynCall": {
        checkExpr(e.callee);
        expectType(e.callee, DYN, "dynCall callee");
        if (e.type.kind !== "dyn") err(`dynCall must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const a of e.args) {
          checkExpr(a);
          if (a.type.kind !== "dyn") err(`dynCall argument of kind ${a.type.kind} (must be dyn)`, e.loc);
        }
        // The runtime-arity form: spread entries point into args (their
        // dyn values flatten at the call), strictly increasing.
        if (e.spreads !== undefined) {
          if (e.spreads.length === 0) err("dynCall spreads must be non-empty when present", e.loc);
          let prev = -1;
          for (const s of e.spreads) {
            if (!Number.isInteger(s.arg) || s.arg < 0 || s.arg >= e.args.length) {
              err(`dynCall spread index ${s.arg} out of range`, e.loc);
            }
            if (s.arg <= prev) err("dynCall spread indices must be strictly increasing", e.loc);
            prev = s.arg;
          }
        }
        break;
      }
      case "dynInvoke": {
        checkExpr(e.recv);
        expectType(e.recv, DYN, "dynInvoke receiver");
        if (e.type.kind !== "dyn") err(`dynInvoke must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const a of e.args) {
          checkExpr(a);
          if (a.type.kind !== "dyn") err(`dynInvoke argument of kind ${a.type.kind} (must be dyn)`, e.loc);
        }
        break;
      }
      case "dynObjLit":
        if (e.type.kind !== "dyn") err(`dynObjLit must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const f of e.fields ?? []) {
          checkExpr(f.key);
          if (f.key.type.kind !== "string") err(`dynObjLit key of kind ${f.key.type.kind} (must be string)`, e.loc);
          checkExpr(f.value);
          if (f.value.type.kind !== "dyn") err(`dynObjLit field value of kind ${f.value.type.kind} (must be dyn)`, e.loc);
        }
        break;
      case "dynArrLit": {
        if (e.type.kind !== "dyn") err(`dynArrLit must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const el of e.elems) {
          checkExpr(el);
          if (el.type.kind !== "dyn") err(`dynArrLit element of kind ${el.type.kind} (must be dyn)`, e.loc);
        }
        break;
      }
      case "unionWrap": {
        // A unitLit is legal exactly HERE: validate it inline (checkExpr
        // rejects bare ones) — the unit spelling must agree with its type,
        // and the generic arm/type agreement below covers the rest.
        if (e.value.kind === "unitLit") {
          const want = e.value.unit === "undefined" ? "undefinedT" : "nullT";
          if (e.value.type.kind !== want) {
            err(`unitLit '${e.value.unit}' typed ${e.value.type.kind}`, e.loc);
          }
        } else {
          checkExpr(e.value);
          if (isUnitType(e.value.type)) {
            err(`unionWrap of a non-literal unit value (${e.value.kind})`, e.loc);
          }
        }
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionWrap of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        if (!typeEquals(e.type, { kind: "union", unionId: e.unionId })) {
          err(`unionWrap type ${e.type.kind} != union ${e.unionId}`, e.loc);
        }
        const arm = def.arms[e.tag];
        if (!Number.isInteger(e.tag) || !arm) {
          err(`unionWrap tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        } else if (e.value.type.kind === "void") {
          // A VOID payload: the backends evaluate the operand for its
          // effects and produce the interned unit instance — legal only
          // against the undefined arm (JS's void value IS undefined).
          if (arm.kind !== "undefinedT") {
            err(`unionWrap of a void value against non-undefined arm ${e.tag} of ${e.unionId}`, e.loc);
          }
        } else if (!typeEquals(e.value.type, arm)) {
          err(`unionWrap value ${e.value.type.kind} != arm ${e.tag} of ${e.unionId}`, e.loc);
        }
        break;
      }
      case "dynTest": {
        checkExpr(e.value);
        expectType(e.value, { kind: "dyn" }, "dynTest operand");
        if (e.type.kind !== "bool") err("dynTest must be bool", e.loc);
        break;
      }
      case "dynKeyGet": {
        checkExpr(e.value);
        checkExpr(e.key);
        expectType(e.value, { kind: "dyn" }, "dynKeyGet operand");
        if (e.key.type.kind !== "string") err(`dynKeyGet key is ${e.key.type.kind}, not string`, e.loc);
        if (e.type.kind !== "dyn") err("dynKeyGet must be dyn", e.loc);
        break;
      }
      case "dynHasKey": {
        checkExpr(e.value);
        expectType(e.value, { kind: "dyn" }, "dynHasKey operand");
        if (e.type.kind !== "bool") err("dynHasKey must be bool", e.loc);
        break;
      }
      case "dynScalarEq": {
        checkExpr(e.left);
        checkExpr(e.right);
        const dynSide = e.left.type.kind === "dyn" ? e.left : e.right;
        const scalarSide = dynSide === e.left ? e.right : e.left;
        if (dynSide.type.kind !== "dyn") err("dynScalarEq needs a dyn side", e.loc);
        if (!["f64", "string", "bool", "dyn"].includes(scalarSide.type.kind)) {
          err(`dynScalarEq scalar side is ${scalarSide.type.kind}`, e.loc);
        }
        if (e.type.kind !== "bool") err("dynScalarEq must be bool", e.loc);
        break;
      }
      case "caughtTest": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtTest operand");
        if (e.type.kind !== "bool") err("caughtTest must be bool", e.loc);
        if (e.test === "instanceof") {
          if (!e.className) err("caughtTest instanceof without a class", e.loc);
          else if (!hierarchy.has(e.className)) {
            err(`caughtTest instanceof against non-hierarchy class "${e.className}"`, e.loc);
          }
        } else if (e.className !== undefined) {
          err(`caughtTest ${e.test} with a class name`, e.loc);
        }
        break;
      }
      case "caughtCheck": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtCheck operand");
        if (!hierarchy.has(e.className)) {
          err(`caughtCheck against non-hierarchy class "${e.className}"`, e.loc);
        }
        if (e.type.kind !== "object" || e.type.className !== e.className) {
          err("caughtCheck type must be the checked class's object type", e.loc);
        }
        break;
      }
      case "caughtToDyn": {
        // The caught snapshot converting to a dyn value (an unknown
        // slot): operand caught, result dyn — the runtime dispatch handles
        // every payload kind, so nothing else constrains it.
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtToDyn operand");
        if (e.type.kind !== "dyn") err(`caughtToDyn must be dyn-typed, got ${e.type.kind}`, e.loc);
        break;
      }
      case "caughtNarrow": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtNarrow operand");
        const t = e.type;
        const ok =
          t.kind === "f64" || t.kind === "bool" || t.kind === "string" ||
          (t.kind === "object" && hierarchy.has(t.className));
        if (!ok) {
          err(`caughtNarrow to ${t.kind === "object" ? `non-hierarchy class "${t.className}"` : t.kind}`, e.loc);
        }
        break;
      }
      case "unionNarrow": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionNarrow of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionNarrow operand");
        const arm = def.arms[e.tag];
        if (!Number.isInteger(e.tag) || !arm) {
          err(`unionNarrow tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        } else if (!typeEquals(e.type, arm)) {
          err(`unionNarrow type ${e.type.kind} != arm ${e.tag} of ${e.unionId}`, e.loc);
        } else if (isUnitType(arm)) {
          // A unit arm has no payload: narrowing to it produces no value,
          // so the frontend never emits this (it leaves the union-typed
          // expression alone in unit-narrowed branches).
          err(`unionNarrow to unit arm ${e.tag} of ${e.unionId}`, e.loc);
        }
        break;
      }
      case "unionDisc": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionDisc of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionDisc receiver");
        // Any representable field type reads through the tag switch (the
        // emitter retains ref results uniformly); units/void can never be
        // record/class field types and have no C value form.
        if (e.type.kind === "void" || e.type.kind === "undefinedT" || e.type.kind === "nullT") {
          err(`unionDisc of valueless type ${e.type.kind}`, e.loc);
        }
        def.arms.forEach((arm, i) => {
          const fieldType =
            arm.kind === "record"
              ? records.get(arm.shapeId)?.fields.find((f) => f.name === e.field)?.type
              : arm.kind === "object"
                ? classes.get(arm.className)?.fields.find((f) => f.name === e.field)?.type
                : undefined;
          if (!fieldType) {
            err(`unionDisc: arm ${i} of ${e.unionId} has no field "${e.field}"`, e.loc);
          } else if (!typeEquals(fieldType, e.type)) {
            err(`unionDisc: arm ${i} field "${e.field}" is ${fieldType.kind}, not ${e.type.kind}`, e.loc);
          }
        });
        break;
      }
      case "unionKeyGet": {
        checkExpr(e.value);
        checkExpr(e.key);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionKeyGet of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionKeyGet receiver");
        if (e.key.type.kind !== "string" && e.key.type.kind !== "f64") {
          err(`unionKeyGet key is ${e.key.type.kind}, not string/number`, e.loc);
        }
        if (e.type.kind === "void" || e.type.kind === "undefinedT" || e.type.kind === "nullT") {
          err(`unionKeyGet of valueless type ${e.type.kind}`, e.loc);
        }
        // Per-arm answerability: the frontend joined the answers into
        // e.type — every arm must surface as it (equal or one of its arms),
        // unit arms need the undefined arm, and non-record/non-array/
        // non-unit arms have no keyed read at all. Number keys read ARRAY
        // arms; string keys read RECORD arms.
        const resultUnion = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
        const surfaces = (t: IrType): boolean =>
          typeEquals(t, e.type) || !!resultUnion?.arms.some((a) => typeEquals(a, t));
        def.arms.forEach((arm, i) => {
          if (arm.kind === "undefinedT" || arm.kind === "nullT") {
            if (!resultUnion?.arms.some((a) => a.kind === "undefinedT")) {
              err(`unionKeyGet: unit arm ${i} of ${e.unionId} needs an undefined arm in the result`, e.loc);
            }
            return;
          }
          if (e.key.type.kind === "f64") {
            if (arm.kind !== "array") {
              err(`unionKeyGet: number-keyed arm ${i} of ${e.unionId} is ${arm.kind}, not an array`, e.loc);
            } else if (!surfaces(arm.elem)) {
              err(`unionKeyGet: arm ${i} element ${arm.elem.kind} cannot surface as the result`, e.loc);
            }
            return;
          }
          if (arm.kind !== "record") {
            err(`unionKeyGet: arm ${i} of ${e.unionId} is ${arm.kind}, not a record`, e.loc);
            return;
          }
          const shape = records.get(arm.shapeId);
          if (!shape) {
            err(`unionKeyGet: arm ${i} of unknown shape ${arm.shapeId}`, e.loc);
            return;
          }
          const literal = e.key.kind === "strLit" ? e.key.value : null;
          const declared = literal !== null ? shape.fields.find((f) => f.name === literal)?.type : undefined;
          if (declared) {
            if (!surfaces(declared)) {
              err(`unionKeyGet: arm ${i} field "${literal}" of type ${declared.kind} cannot surface as the result`, e.loc);
            }
            return;
          }
          if (!shape.indexValue && !(literal === null && shape.fields.length > 0)) {
            err(`unionKeyGet: arm ${i} of ${e.unionId} has no answer for the key`, e.loc);
          }
        });
        break;
      }
      case "unionIsTag": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionIsTag of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionIsTag operand");
        if (!Number.isInteger(e.tag) || !def.arms[e.tag]) {
          err(`unionIsTag tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        }
        if (e.type.kind !== "bool") err("unionIsTag must be bool", e.loc);
        break;
      }
      case "intrinsic":
        if (e.name === "module.await") {
          if (e.args.length !== 1) err("module.await takes exactly one argument", e.loc);
          for (const a of e.args) {
            checkExpr(a);
            if (a.type.kind !== "promise" || a.type.inner.kind !== "void") {
              err(`${typeKey(a.type)} argument to module.await (needs promise<void>)`, a.loc);
            }
          }
          if (e.type.kind !== "void") err("module.await must be void", e.loc);
          break;
        }
        if (e.name === "promise.all") {
          // ONE argument: an array of promises whose inner type is the
          // result's array element (or void, collapsing to promise<void>).
          // The exact-inner-type rule is the frontend's fence; the coarse
          // shape keeps hand-written IR honest.
          if (e.args.length !== 1) err("promise.all takes exactly one argument", e.loc);
          for (const a of e.args) {
            checkExpr(a);
            if (a.type.kind !== "array" || a.type.elem.kind !== "promise") {
              err(`${a.type.kind} argument to promise.all (needs an array of promises)`, a.loc);
            }
          }
          if (e.type.kind !== "promise") err("promise.all must be promise-typed", e.loc);
          else if (e.type.inner.kind !== "array" && e.type.inner.kind !== "void") {
            err("promise.all result must be a promise of an array (or void)", e.loc);
          }
          break;
        }
        if (e.name === "promise.reject") {
          // ONE argument: the %Error-rooted reason object (the rejection
          // payload shares the thrown-Error representation — the
          // frontend's fence pins the hierarchy; the coarse object shape
          // keeps hand-written IR honest) or a checked-dynamic reason
          // (the thrown-dyn representation — identity flows to catch and
          // unhandledRejection observers). The result is the
          // context-named promise.
          if (e.args.length !== 1) err("promise.reject takes exactly one argument", e.loc);
          for (const a of e.args) {
            checkExpr(a);
            if (a.type.kind !== "object" && a.type.kind !== "dyn") {
              err(`${a.type.kind} argument to promise.reject (needs an Error object or a dyn reason)`, a.loc);
            }
          }
          if (e.type.kind !== "promise") err("promise.reject must be promise-typed", e.loc);
          break;
        }
        if (e.name === "promise.resolve") {
          // Zero args (Promise<void>) or one plain value of the result's
          // inner type — promise arguments never reach the intrinsic
          // (the frontend returns them as-is).
          if (e.args.length > 1) err("promise.resolve takes at most one argument", e.loc);
          for (const a of e.args) {
            checkExpr(a);
            if (a.type.kind === "promise") {
              err("promise argument to promise.resolve (identity belongs in the frontend)", a.loc);
            }
          }
          if (e.type.kind !== "promise") err("promise.resolve must be promise-typed", e.loc);
          else if (e.args.length === 0 && e.type.inner.kind !== "void") {
            err("zero-argument promise.resolve must be promise<void>", e.loc);
          } else if (e.args.length === 1 && !typeEquals(e.args[0]!.type, e.type.inner)) {
            err("promise.resolve argument must be the result's inner type", e.loc);
          }
          break;
        }
        if (e.name === "promise.race") {
          // Entries are promises; the result is the combined promise. The
          // per-entry inner-type compatibility (equal to the result inner,
          // one of its union arms, or a sub-union of it) is the frontend's
          // fence; here the coarse shape keeps hand-written IR honest.
          if (e.args.length === 0) err("promise.race with no entries", e.loc);
          for (const a of e.args) {
            checkExpr(a);
            if (a.type.kind !== "promise") {
              err(`${a.type.kind} entry in promise.race`, a.loc);
            }
          }
          if (e.type.kind !== "promise") err("promise.race must be promise-typed", e.loc);
          break;
        }
        for (const a of e.args) {
          checkExpr(a);
          // Arrays/functions/records/unions stay out of console.log (and
          // its stderr twin console.error) by design (the ambient signature
          // accepts number|string|boolean; a union of those satisfies it,
          // so the frontend rejects union args explicitly) — inspect
          // formatting is unimplemented, so the backend must never see one.
          if (a.type.kind !== "f64" && a.type.kind !== "string" && a.type.kind !== "bool") {
            err(`${a.type.kind} argument to ${e.name}`, a.loc);
          }
        }
        if (e.type.kind !== "void") err(`${e.name} must be void`, e.loc);
        break;
      case "libCall": {
        const sig = LIB_FN_SIGS[e.fn];
        if (!sig) {
          err(`libCall of unknown library function "${e.fn as string}"`, e.loc);
          break;
        }
        // emitter.emit is variadic: (recv, name) plus the event's tuple.
        // The stream constructors (trailing option callbacks), write/end
        // (the optional chunk/cb tail), and unpipe (the optional
        // destination) admit a longer list the same way.
        const variadic =
          e.fn === "emitter.emit" ||
          e.fn === "readable.new" || e.fn === "writable.new" ||
          e.fn === "duplex.new" || e.fn === "transform.new" ||
          e.fn === "passthrough.new" ||
          e.fn === "readable.init" || e.fn === "writable.init" ||
          e.fn === "duplex.init" || e.fn === "transform.init" ||
          e.fn === "passthrough.init" ||
          e.fn === "readable.initDyn" || e.fn === "writable.initDyn" ||
          e.fn === "duplex.initDyn" || e.fn === "transform.initDyn" ||
          e.fn === "passthrough.initDyn" ||
          e.fn === "stream.pipeline" || e.fn === "stream.pipelineDyn" ||
          e.fn === "sp.pipeline" ||
          e.fn === "writable.write" ||
          e.fn === "writable.writeStr" || e.fn === "writable.writeU" ||
          e.fn === "writable.end" ||
          e.fn === "readable.unpipe";
        if (variadic
          ? e.args.length < sig.argTypes.length
          : e.args.length !== sig.argTypes.length) {
          err(`libCall ${e.fn}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `libCall ${e.fn} arg ${i}`);
        });
        if (e.fn === "fileHandle.read" || e.fn === "fileHandle.writeBytes" || e.fn === "fileHandle.writeStr") {
          const inner = e.type.kind === "promise" ? e.type.inner : undefined;
          const shape = inner?.kind === "record" ? records.get(inner.shapeId) : undefined;
          const countName = e.fn === "fileHandle.read" ? "bytesRead" : "bytesWritten";
          const payload = e.args[1]?.type;
          const count = shape?.fields.find((f) => f.name === countName);
          const buffer = shape?.fields.find((f) => f.name === "buffer");
          const ok =
            shape !== undefined && !shape.tuple && shape.indexValue === undefined && shape.fields.length === 2 &&
            count?.type.kind === "f64" && payload !== undefined && buffer !== undefined &&
            typeEquals(buffer.type, payload);
          if (!ok) {
            err(`libCall ${e.fn} must return a promise of { ${countName}: number, buffer }`, e.loc);
          }
          break;
        }
        if (e.fn === "fetch.streamFrom") {
          const t = e.args[0]?.type;
          const ok =
            t?.kind === "string" ||
            (t?.kind === "bytes" && t.elem === "u8") ||
            (t?.kind === "array" &&
              canConvertToDyn(
                t.elem,
                (id) => records.get(id),
                (id) => unions.get(id),
              )) ||
            t?.kind === "dyn";
          if (!ok) {
            err(
              `libCall fetch.streamFrom arg 0: expected a supported iterable, got ${t?.kind}`,
              e.loc,
            );
          }
          break;
        }
        if (e.fn === "fetch.readerRead") {
          if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
            err(
              `libCall fetch.readerRead must return a promise of a read-result record`,
              e.loc,
            );
          }
          break;
        }
        if (e.fn === "fetch.responseText" || e.fn === "fetch.responseBytes") {
          const valueType = e.fn === "fetch.responseText" ? STRING : BYTES_U8;
          const inner = e.type.kind === "promise" ? e.type.inner : null;
          const union = inner?.kind === "union" ? unions.get(inner.unionId) : undefined;
          if (
            inner === null ||
            (!typeEquals(inner, valueType) &&
              !union?.arms.some((arm) => typeEquals(arm, valueType)))
          ) {
            err(
              `libCall ${e.fn} must return a promise whose value includes ${valueType.kind}`,
              e.loc,
            );
          }
          break;
        }
        if (e.fn === "string.fromCharCode") {
          // One packed f64[] or one bytes value (the spread form).
          const t = e.args[0]?.type;
          const ok =
            t && ((t.kind === "array" && t.elem.kind === "f64") || t.kind === "bytes");
          if (!ok) {
            err(`libCall string.fromCharCode arg 0: expected number[] or bytes, got ${t?.kind}`, e.loc);
          }
          break;
        }
        if (e.fn === "process.envGet") {
          // Result is the module's interned `string | undefined` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "string" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall process.envGet must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "process.columns") {
          // Result is the module's interned `number | undefined` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "f64" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall process.columns must return the 'number | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "http.createServer" || e.fn === "http2.createServerReq") {
          // The request handler: void, at most (req, res) in order.
          const cbT = e.args[0]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 2;
          if (ok && cbT?.kind === "func") {
            const [p0, p1] = cbT.params;
            if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
            if (p1 !== undefined && p1.kind !== "httpRes") ok = false;
          }
          if (!ok) {
            err(`libCall ${e.fn} handler shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.serverOnRequest") {
          // The 'request' listener: the same shape as http.createServer's
          // handler — void, at most (req, res) in order.
          const cbT = e.args[1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 2;
          if (ok && cbT?.kind === "func") {
            const [p0, p1] = cbT.params;
            if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
            if (p1 !== undefined && p1.kind !== "httpRes") ok = false;
          }
          if (!ok) {
            err(`libCall http.serverOnRequest handler shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http2.serverOnSessionError") {
          const cbT = e.args[1]?.type;
          if (cbT?.kind !== "func" || cbT.ret.kind !== "void") {
            err(`libCall http2.serverOnSessionError callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.reqOnData") {
          const cbT = e.args[1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            const p = cbT.params[0]!;
            // dyn = the checked-dynamic listener's adapter (the chunk
            // boxes Buffer-flavored in the runtime data thunk).
            ok = (p.kind === "bytes" && p.elem === "u8") || p.kind === "dyn";
          }
          if (!ok) {
            err(`libCall http.reqOnData callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.reqStatusCode") {
          // Result is the module's interned `number | undefined` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "f64" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall http.reqStatusCode must return the 'number | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "net.sockRemoteAddress") {
          // Result is the interned `string | undefined` union (envGet's).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "string" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall net.sockRemoteAddress must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "net.sockEncrypted") {
          // Result is the interned `boolean | undefined` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "bool" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall net.sockEncrypted must return the 'boolean | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "tls.sockAuthError") {
          // Result is the interned `string | null` union (Node's
          // authorizationError: the verify-failure code string, or null).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "string" &&
            def.arms[1]!.kind === "nullT";
          if (!ok) {
            err(`libCall tls.sockAuthError must return the 'string | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "http.requestCb" || e.fn === "https.requestCb" ||
            e.fn === "http.requestUrlCb" || e.fn === "http.clientOnResponse" ||
            e.fn === "http.requestAgentCb" || e.fn === "https.requestAgentCb" ||
            e.fn === "https.requestUrlCb") {
          // The response listener: void, no params or exactly (res: httpReq).
          const cbT = e.args[
            e.fn === "http.requestCb" ? 7
            : e.fn === "https.requestCb" ? 9
            : e.fn === "http.requestUrlCb" || e.fn === "https.requestUrlCb" ? 3
            : e.fn === "http.requestAgentCb" ? 8
            : e.fn === "https.requestAgentCb" ? 10
            : 1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            ok = cbT.params[0]!.kind === "httpReq";
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.reqOnError" || e.fn === "http.clientOnError") {
          // The error listener: void, no params or exactly (err: %Error).
          const cbT = e.args[1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            const p = cbT.params[0]!;
            ok = p.kind === "object" && p.className === "%Error";
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "net.sockRead") {
          // Result is the interned `Buffer | null` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "bytes" && a.elem === "u8") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) {
            err(`libCall net.sockRead must return the 'Buffer | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "http.serverOnUpgrade" || e.fn === "http.clientOnUpgrade" ||
            e.fn === "http.serverOnConnect") {
          // (req, socket, head) or any shorter prefix, void return. The
          // 'connect' registration additionally admits a socket slot
          // that is a UNION carrying a netSocket arm (the h2 compat
          // listener — the emitted adapter wraps the socket there).
          const cbT = e.args[1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 3;
          if (ok && cbT?.kind === "func") {
            const [p0, p1, p2] = cbT.params;
            if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
            if (p1 !== undefined && p1.kind !== "netSocket") {
              if (e.fn === "http.serverOnConnect" && p1?.kind === "union") {
                const def = unions.get(p1.unionId);
                if (!def || !def.arms.some((a) => a.kind === "netSocket")) ok = false;
              } else {
                ok = false;
              }
            }
            if (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8")) ok = false;
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "net.listenOptsCb") {
          const t = e.args[4]?.type;
          const funcOk = (x: IrType | undefined): boolean =>
            x?.kind === "func" && x.params.length === 0 && x.ret.kind === "void";
          let ok = funcOk(t);
          if (!ok && t?.kind === "union") {
            const def = unions.get(t.unionId);
            ok = !!def && def.arms.length === 2 && def.arms.some((a) => funcOk(a)) &&
              def.arms.some((a) => a.kind === "undefinedT");
          }
          if (!ok) {
            err(`libCall net.listenOptsCb callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "net.connectLookup") {
          // The caller's resolver: (hostname: string, options: unknown,
          // callback: (err: <union>, addresses: <record[]>) => void) =>
          // void — the emitter synthesizes the answer thunk from these
          // types, so the structure must hold.
          const t = e.args[2]?.type;
          let ok =
            t?.kind === "func" && t.ret.kind === "void" && t.params.length === 3 &&
            t.params[0]!.kind === "string" && t.params[1]!.kind === "dyn";
          if (ok && t?.kind === "func") {
            const cbT = t.params[2]!;
            ok = cbT.kind === "func" && cbT.ret.kind === "void" && cbT.params.length === 2 &&
              cbT.params[0]!.kind === "union" &&
              cbT.params[1]!.kind === "array" && cbT.params[1]!.elem.kind === "record";
          }
          if (!ok) {
            err(`libCall net.connectLookup resolver shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.requestConn" || e.fn === "http.requestConnCb") {
          const dialT = e.args[0]?.type;
          if (!(dialT?.kind === "func" && dialT.params.length === 0 && dialT.ret.kind === "netSocket")) {
            err(`libCall ${e.fn} dialer shape (frontend must fence)`, e.loc);
            break;
          }
          if (e.fn === "http.requestConnCb") {
            const cbT = e.args[6]?.type;
            const ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1 &&
              (cbT.params[0] === undefined || cbT.params[0].kind === "httpReq");
            if (!ok) err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http.reqStatusMessage") {
          // Result is the interned `string | undefined` union (reqHeader's).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "string") &&
            def.arms.some((a) => a.kind === "undefinedT");
          if (!ok) {
            err(`libCall http.reqStatusMessage must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "http.reqHeader" || e.fn === "http.resGetHeader") {
          // Result is the interned `string | undefined` union (envGet's).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "string" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall ${e.fn} must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "net.createServerCb" || e.fn === "net.serverOnConnection" ||
            e.fn === "net.serverOnSecureConnection" ||
            e.fn === "net.sockOnData" || e.fn === "net.serverOnError" ||
            e.fn === "net.sockOnError") {
          // The program-dependent listener shapes: a void closure with no
          // params, or exactly the one supported parameter per event
          // (socket handle / data chunk bytes / error %Error). The
          // callback slot is arg 0 for createServerCb, arg 1 otherwise.
          const cbT = e.args[e.fn === "net.createServerCb" ? 0 : 1]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            const p = cbT.params[0]!;
            if (e.fn === "net.sockOnData") ok = (p.kind === "bytes" && p.elem === "u8") || p.kind === "dyn";
            else if (e.fn === "net.serverOnError" || e.fn === "net.sockOnError") {
              ok = p.kind === "object" && p.className === "%Error";
            } else ok = p.kind === "netSocket";
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "http2.createSecureServerSni") {
          // The SNI callback: (servername: string, cb: (err, ctx?) => void)
          // => void — as a bare func, or the `| undefined` union from the
          // conditional-spread spelling (exactly two arms: the func and
          // undefined). The cb's own params are program-interned unions
          // (Error|null, SecureContext|undefined) whose arms the emitted
          // answer thunk decodes; here the structural func shape is what
          // the validator can pin.
          const sniOk = (t: IrType | undefined): boolean =>
            t?.kind === "func" && t.ret.kind === "void" && t.params.length === 2 &&
            t.params[0]!.kind === "string" && t.params[1]!.kind === "func";
          const argT = e.args[2]?.type;
          let ok = sniOk(argT);
          if (!ok && argT?.kind === "union") {
            const def = unions.get(argT.unionId);
            ok = def !== undefined && def.arms.length === 2 &&
              def.arms.some((a) => a.kind === "undefinedT") &&
              def.arms.some((a) => sniOk(a));
          }
          if (!ok) {
            err(`libCall ${e.fn} SNI callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "dgram.onMessage" || e.fn === "dgram.onError") {
          // The dgram listener shapes: a void closure with no params, or
          // the per-event parameter shapes — message takes (msg: bytes<u8>
          // [, rinfo: record]), error the one %Error param.
          const cbT = e.args[1]?.type;
          const maxParams = e.fn === "dgram.onMessage" ? 2 : 1;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= maxParams;
          if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
            if (e.fn === "dgram.onMessage") {
              const p0 = cbT.params[0]!;
              ok = p0.kind === "bytes" && p0.elem === "u8";
              const p1 = cbT.params[1];
              if (ok && p1 !== undefined) ok = p1.kind === "record";
            } else {
              const p = cbT.params[0]!;
              ok = p.kind === "object" && p.className === "%Error";
            }
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "dns.lookup") {
          // The callback: void, at most (err: Error | null, address:
          // string, family: number).
          const cbT = e.args[2]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 3;
          if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
            const p0 = cbT.params[0]!;
            const def = p0.kind === "union" ? unions.get(p0.unionId) : undefined;
            ok =
              def !== undefined &&
              def.arms.length === 2 &&
              def.arms.some((a) => a.kind === "nullT") &&
              def.arms.some((a) => a.kind === "object" && a.className === "%Error");
            const p1 = cbT.params[1];
            if (ok && p1 !== undefined) ok = p1.kind === "string";
            const p2 = cbT.params[2];
            if (ok && p2 !== undefined) ok = p2.kind === "f64";
          }
          if (!ok) {
            err(`libCall dns.lookup callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (
          e.fn === "fs.renameCb" ||
          e.fn === "process.stdoutWriteBytesCb" ||
          e.fn === "process.stderrWriteBytesCb"
        ) {
          // The callback is void and accepts either no parameters, one
          // checked-dynamic error slot (JS), or Error | null (optionally
          // including undefined for an explicitly optional parameter).
          const cbT = e.args[2]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            const p = cbT.params[0]!;
            if (p.kind === "dyn") {
              ok = true;
            } else {
              const def = p.kind === "union" ? unions.get(p.unionId) : undefined;
              ok =
                def !== undefined &&
                def.arms.some((a) => a.kind === "nullT") &&
                def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
                def.arms.every((a) =>
                  a.kind === "nullT" || a.kind === "undefinedT" ||
                  (a.kind === "object" && a.className === "%Error"));
            }
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "net.serverAddress") {
          // Result is the {address, family, port} record (dgram.address's
          // check, another receiver).
          const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
          const ok =
            shape !== undefined &&
            shape.fields.length === 3 &&
            shape.fields[0]!.name === "address" && shape.fields[0]!.type.kind === "string" &&
            shape.fields[1]!.name === "family" && shape.fields[1]!.type.kind === "string" &&
            shape.fields[2]!.name === "port" && shape.fields[2]!.type.kind === "f64";
          if (!ok) {
            err(`libCall net.serverAddress must return the {address, family, port} record`, e.loc);
          }
          break;
        }
        if (e.fn === "dgram.address") {
          // Result is the {address, family, port} record.
          const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
          const ok =
            shape !== undefined &&
            shape.fields.length === 3 &&
            shape.fields[0]!.name === "address" && shape.fields[0]!.type.kind === "string" &&
            shape.fields[1]!.name === "family" && shape.fields[1]!.type.kind === "string" &&
            shape.fields[2]!.name === "port" && shape.fields[2]!.type.kind === "f64";
          if (!ok) {
            err(`libCall dgram.address must return the {address, family, port} record`, e.loc);
          }
          break;
        }
        if (e.fn === "fs.readdirTypesSync") {
          // Result: the interned Dirent record array — {%dtype: f64,
          // name: string, parentPath: string} rows (canonical field
          // order; the structure lowerFsReaddirTypesCall pinned).
          const shape =
            e.type.kind === "array" && e.type.elem.kind === "record"
              ? records.get(e.type.elem.shapeId)
              : undefined;
          const ok =
            shape !== undefined &&
            !shape.tuple &&
            shape.indexValue === undefined &&
            shape.fields.length === 3 &&
            shape.fields[0]!.name === "%dtype" && shape.fields[0]!.type.kind === "f64" &&
            shape.fields[1]!.name === "name" && shape.fields[1]!.type.kind === "string" &&
            shape.fields[2]!.name === "parentPath" && shape.fields[2]!.type.kind === "string";
          if (!ok) {
            err(`libCall fs.readdirTypesSync must return the Dirent record array`, e.loc);
          }
          break;
        }
        if (e.fn === "os.networkInterfaces") {
          // Result: a pure index-signature record whose value is
          // `Info[] | undefined`, Info a two-record union (one arm's
          // scopeid f64, the other's `number | undefined`) — the structure
          // lowerOsNetworkInterfacesCall pinned.
          const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
          let ok = shape !== undefined && !shape.tuple && shape.fields.length === 0 && shape.indexValue !== undefined;
          const ivDef = ok && shape!.indexValue!.kind === "union" ? unions.get(shape!.indexValue!.unionId) : undefined;
          const arrArm = ivDef?.arms.find((a) => a.kind === "array");
          ok = ok && ivDef !== undefined && ivDef.arms.length === 2 && arrArm !== undefined && ivDef.arms.some((a) => a.kind === "undefinedT");
          const infoDef = ok && arrArm!.kind === "array" && arrArm!.elem.kind === "union" ? unions.get(arrArm!.elem.unionId) : undefined;
          ok = ok && infoDef !== undefined && infoDef.arms.length === 2 && infoDef.arms.every((a) => a.kind === "record");
          if (!ok) {
            err(`libCall os.networkInterfaces must return the NetworkInterfaceInfo dictionary record`, e.loc);
          }
          break;
        }
        if (e.fn === "qs.parse") {
          // Result: a pure index-signature record whose value union
          // carries a string arm and a string[] arm (undefined tolerated
          // — @types/node's Dict — and f64 too: the header-family
          // canonicalization interns every such dictionary with the
          // number arm, type-level only) — the structure
          // lowerQuerystringParseCall pinned.
          const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
          let ok = shape !== undefined && !shape.tuple && shape.fields.length === 0 && shape.indexValue !== undefined;
          const ivDef = ok && shape!.indexValue!.kind === "union" ? unions.get(shape!.indexValue!.unionId) : undefined;
          ok = ok && ivDef !== undefined &&
            ivDef.arms.some((a) => a.kind === "string") &&
            ivDef.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
            ivDef.arms.every((a) => a.kind === "string" || a.kind === "array" || a.kind === "undefinedT" || a.kind === "f64");
          if (!ok) {
            err(`libCall qs.parse must return the ParsedUrlQuery dictionary record`, e.loc);
          }
          break;
        }
        if (e.fn === "child.onExit" || e.fn === "child.onError") {
          // The listener: a closure with no params, or exactly the
          // supported parameter shapes per event — exit takes (code:
          // number | null) with an optional (signal: string | null)
          // second parameter, error exactly (err: %Error).
          const cb = e.args[1];
          const cbT = cb?.type;
          const maxParams = e.fn === "child.onExit" ? 2 : 1;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= maxParams;
          if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
            const p = cbT.params[0]!;
            if (e.fn === "child.onExit") {
              const def = p.kind === "union" ? unions.get(p.unionId) : undefined;
              ok =
                def !== undefined &&
                def.arms.length === 2 &&
                def.arms[0]!.kind === "f64" &&
                def.arms[1]!.kind === "nullT";
              if (ok && cbT.params.length === 2) {
                const s = cbT.params[1]!;
                const sdef = s.kind === "union" ? unions.get(s.unionId) : undefined;
                ok =
                  sdef !== undefined &&
                  sdef.arms.length === 2 &&
                  sdef.arms.some((a) => a.kind === "string") &&
                  sdef.arms.some((a) => a.kind === "nullT");
              }
            } else {
              ok = p.kind === "object" && p.className === "%Error";
            }
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "process.onExit" || e.fn === "process.offExit" ||
            e.fn === "stdin.onData" || e.fn === "stdin.onError") {
          // The listener: a void closure with no params, or exactly the
          // one supported parameter shape per event (code number / data
          // chunk bytes / error %Error).
          const cbT = e.args[0]?.type;
          let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
          if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
            const p = cbT.params[0]!;
            if (e.fn === "stdin.onData") ok = p.kind === "bytes" && p.elem === "u8";
            else if (e.fn === "stdin.onError") ok = p.kind === "object" && p.className === "%Error";
            else ok = p.kind === "f64";
          }
          if (!ok) {
            err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
          }
          break;
        }
        if (e.fn === "spawnRes.status") {
          // Result is the module's interned `number | null` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "f64" &&
            def.arms[1]!.kind === "nullT";
          if (!ok) {
            err(`libCall spawnRes.status must return the 'number | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "spawnRes.signal") {
          // Result is the module's interned `string | null` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "string") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) {
            err(`libCall spawnRes.signal must return the 'string | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "sp.get") {
          // Result is the interned `string | null` union (the runtime
          // answers +1-or-NULL; the backend builds the arms).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "string") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) {
            err(`libCall sp.get must return the 'string | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "sp.fromPairs") {
          const t = e.args[0]?.type;
          const ok = t && t.kind === "array" && t.elem.kind === "array" && t.elem.elem.kind === "string";
          if (!ok) {
            err(`libCall sp.fromPairs arg 0: expected string[][], got ${t?.kind}`, e.loc);
          }
          break;
        }
        if (e.fn === "sym.desc" || e.fn === "sym.keyFor") {
          // Result is the interned `string | undefined` union (the
          // runtime answers +1-or-NULL; the backend builds the arms).
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "string") &&
            def.arms.some((a) => a.kind === "undefinedT");
          if (!ok) {
            err(`libCall ${e.fn} must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "spawnRes.error") {
          // Result is the interned `%Error | undefined` union.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
            def.arms.some((a) => a.kind === "undefinedT");
          if (!ok) {
            err(`libCall spawnRes.error must return the 'Error | undefined' union`, e.loc);
          }
          break;
        }
        if (e.fn === "child.pid" || e.fn === "child.exitCode") {
          // pid: the interned `number | undefined`; exitCode: `number | null`.
          const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "f64" &&
            def.arms[1]!.kind === wantUnit;
          if (!ok) {
            err(
              `libCall ${e.fn} must return the 'number | ${wantUnit === "nullT" ? "null" : "undefined"}' union`,
              e.loc,
            );
          }
          break;
        }
        if (e.fn === "net.serverCloseBind") {
          // The bound close: (cbUnion) => netServer, cbUnion carrying a
          // void-returning func arm (≤1 param) and the undefined arm.
          const t = e.type;
          const cbU = t.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
          const def = cbU?.kind === "union" ? unions.get(cbU.unionId) : undefined;
          const ok =
            t.kind === "func" && (t.ret.kind === "netServer" || t.ret.kind === "void") &&
            def &&
            def.arms.some((a) => a.kind === "func" && a.params.length <= 1 && a.ret.kind === "void") &&
            def.arms.some((a) => a.kind === "undefinedT");
          if (!ok) {
            err(`libCall net.serverCloseBind must produce the bound-close func type`, e.loc);
          }
          break;
        }
        if (e.fn === "child.stdout" || e.fn === "child.stderr") {
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "childStream") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) {
            err(`libCall ${e.fn} must return the 'Readable | null' union`, e.loc);
          }
          break;
        }
        if (e.fn === "island.castFail") {
          // The deferred boundary failure's typed dummy: a promise (the
          // only cast shape the frontend defers).
          if (e.type.kind !== "promise") {
            err(`libCall island.castFail must return a promise type, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        if (e.fn === "global.undefRead") {
          // Always throws — the result type is whatever the declared type
          // of the undefined global mapped to (never materialized).
          break;
        }
        if (e.fn === "error.nodeThrow" || e.fn === "error.argTypeThrow" || e.fn === "error.propTypeThrow" ||
            e.fn === "fs.mkdtempChk" || e.fn === "fs.readFileChk" ||
            e.fn === "fs.opendirChk" || e.fn === "fs.watchFileChk" || e.fn === "fs.lchmodChk" ||
            e.fn === "fs.readChk" || e.fn === "fs.streamOptsChk" || e.fn === "net.connectOptsChk" ||
            e.fn === "tls.caCertsChk") {
          // Always throws — the result type is the replaced expression's
          // own (never materialized; the global.undefRead pattern). The
          // fs Chk ladders qualify: every validation failure throws
          // Node's typed error, and a full pass throws the trailing
          // compiler-rendered fence.
          break;
        }
        if (e.fn === "error.new") {
          // Which builtin the runtime constructs is named by the result type.
          if (!isBuiltinErrorObject(e.type)) {
            err(`libCall error.new must return a builtin error class, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        if (e.fn === "error.newDom") {
          if (e.type.kind !== "object" || e.type.className !== "%DOMException") {
            err(`libCall error.newDom must return %DOMException, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        if (e.fn === "error.domCode" || e.fn === "error.domHasCause" || e.fn === "error.domCause" || e.fn === "error.domClone") {
          // Receiver: exactly %DOMException (subclassing is fenced — the
          // hidden runtime slots admit no other layout).
          const recv = e.args[0];
          if (!recv || recv.type.kind !== "object" || recv.type.className !== "%DOMException") {
            err(`libCall ${e.fn} receiver must be %DOMException`, e.loc);
          }
          break;
        }
        if (e.fn === "class.name") {
          // The arg is any class value (program-dependent classval).
          if (e.args[0]?.type.kind !== "classval") {
            err(`libCall class.name takes a class value`, e.loc);
          }
          if (e.type.kind !== "string") {
            err(`libCall class.name must return string`, e.loc);
          }
          break;
        }
        if (e.fn === "assert.refEqBytes" || e.fn === "assert.bytesDeepEq") {
          // Both value slots: ONE static bytes type (the frontend's
          // same-static-type gate — a u8/u32 mix would memcmp garbage).
          const a = e.args[0]?.type;
          const b = e.args[1]?.type;
          if (a?.kind !== "bytes" || b === undefined || !typeEquals(a, b)) {
            err(`libCall ${e.fn} takes two same-typed bytes values`, e.loc);
          }
          break;
        }
        if (e.fn === "assert.refEqFn") {
          // ANY two function signatures: the compare is pointer identity.
          if (e.args[0]?.type.kind !== "func" || e.args[1]?.type.kind !== "func") {
            err(`libCall assert.refEqFn takes two function values`, e.loc);
          }
          break;
        }
        if (e.fn === "error.code") {
          // Receiver: any error-hierarchy object (a user subclass embeds
          // the code slot in its prefix); result: the interned
          // `string | undefined` union (the process.envGet pattern).
          const recv = e.args[0];
          if (!recv || recv.type.kind !== "object") {
            err(`libCall error.code receiver must be an error object`, e.loc);
            break;
          }
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "string" &&
            def.arms[1]!.kind === "undefinedT";
          if (!ok) {
            err(`libCall error.code must return the 'string | undefined' union`, e.loc);
          }
          break;
        }
        if (
          e.fn.startsWith("readable.") || e.fn.startsWith("writable.") ||
          e.fn.startsWith("duplex.") || e.fn.startsWith("transform.") ||
          e.fn.startsWith("passthrough.") || e.fn === "stream.destroy" ||
          e.fn === "stream.destroyErr" || e.fn === "stream.prop" ||
          e.fn === "stream.errored" || e.fn === "stream.finished" ||
          e.fn === "stream.finishedDyn" || e.fn === "stream.pipeline" ||
          e.fn === "stream.pipelineDyn"
        ) {
          // Receiver/result: stream-hierarchy objects (a class whose base
          // chain reaches a runtime stream class). Constructors have no
          // receiver — their RESULT names the class; chaining forms
          // return the receiver's static type; pipe returns its
          // destination's.
          const isStreamObject = (t: IrType | undefined): boolean => {
            if (t?.kind !== "object") return false;
            let name: string | undefined = t.className;
            while (name !== undefined) {
              if (RUNTIME_STREAM_CLASSES.has(name)) return true;
              name = classes.get(name)?.base;
            }
            return false;
          };
          if (e.fn.endsWith(".new")) {
            if (!isStreamObject(e.type)) {
              err(`libCall ${e.fn} must return a stream class, got ${e.type.kind}`, e.loc);
            }
            for (let i = sig.argTypes.length; i < e.args.length; i++) {
              if (e.args[i]!.type.kind !== "func") {
                err(`libCall ${e.fn} option callback ${i} must be a func`, e.loc);
              }
            }
            break;
          }
          if (e.fn.endsWith(".newDyn")) {
            // The dyn-options constructor: (optsDyn) → the stream class.
            if (!isStreamObject(e.type)) {
              err(`libCall ${e.fn} must return a stream class, got ${e.type.kind}`, e.loc);
            }
            break;
          }
          if (e.fn.endsWith(".initDyn")) {
            // (recv, optsDyn, flags, ...fallback wrapper closures).
            if (!isStreamObject(e.args[0]?.type)) {
              err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
            }
            for (let i = sig.argTypes.length; i < e.args.length; i++) {
              if (e.args[i]!.type.kind !== "func") {
                err(`libCall ${e.fn} fallback callback ${i} must be a func`, e.loc);
              }
            }
            if (e.type.kind !== "void") err(`libCall ${e.fn} must be void`, e.loc);
            break;
          }
          if (e.fn === "stream.finished" || e.fn === "stream.finishedDyn") {
            // (recv, cb) → the cleanup closure.
            if (!isStreamObject(e.args[0]?.type)) {
              err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
            }
            const cbK = e.args[1]?.type.kind;
            if (e.fn === "stream.finished" ? cbK !== "func" : cbK !== "dyn") {
              err(`libCall ${e.fn} callback must be ${e.fn === "stream.finished" ? "a func" : "dyn"}`, e.loc);
            }
            if (e.type.kind !== "func") {
              err(`libCall ${e.fn} must return the cleanup closure, got ${e.type.kind}`, e.loc);
            }
            break;
          }
          if (e.fn === "stream.pipeline" || e.fn === "stream.pipelineDyn") {
            // (count, s1..sn, cb) → the destination's type.
            const count = e.args[0];
            const n = count?.kind === "numLit" ? count.value : -1;
            if (n < 2 || e.args.length !== n + 2) {
              err(`libCall ${e.fn} count/arity mismatch`, e.loc);
              break;
            }
            for (let i = 1; i <= n; i++) {
              if (!isStreamObject(e.args[i]?.type)) {
                err(`libCall ${e.fn} stage ${i} must be a stream-hierarchy object`, e.loc);
              }
            }
            const cbK = e.args[n + 1]?.type.kind;
            if (e.fn === "stream.pipeline" ? cbK !== "func" : cbK !== "dyn") {
              err(`libCall ${e.fn} callback must be ${e.fn === "stream.pipeline" ? "a func" : "dyn"}`, e.loc);
            }
            if (!typeEquals(e.type, e.args[n]!.type)) {
              err(`libCall ${e.fn} must return its destination's type`, e.loc);
            }
            break;
          }
          if (e.fn === "readable.fromArr") {
            // No receiver: the seed array leads; the result is the class.
            if (e.args[0]?.type.kind !== "array" || !isStreamObject(e.type)) {
              err(`libCall readable.fromArr must take an array and return a stream class`, e.loc);
            }
            break;
          }
          if (!isStreamObject(e.args[0]?.type)) {
            err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
            break;
          }
          if (e.fn === "readable.nextChunk" || e.fn === "readable.nextChunkDyn") {
            if (e.type.kind !== "promise") {
              err(`libCall ${e.fn} must return a promise, got ${e.type.kind}`, e.loc);
            }
            break;
          }
          if (e.fn === "readable.pause" || e.fn === "readable.resume" ||
              e.fn === "readable.unpipe" || e.fn === "writable.end" ||
              e.fn === "readable.setEncoding" || e.fn === "readable.pushEncoding" ||
              e.fn === "stream.destroy" || e.fn === "stream.destroyErr") {
            if (!typeEquals(e.type, e.args[0]!.type)) {
              err(`libCall ${e.fn} must return its receiver's type (the chaining 'this')`, e.loc);
            }
            break;
          }
          if (e.fn === "readable.pipe") {
            if (!isStreamObject(e.args[1]?.type) || !typeEquals(e.type, e.args[1]!.type)) {
              err(`libCall readable.pipe must return its destination's type`, e.loc);
            }
            break;
          }
          if (e.fn === "readable.read" || e.fn === "readable.flowing" || e.fn === "stream.errored") {
            const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
            const wantArm = (t: IrType): boolean =>
              e.fn === "readable.read" ? t.kind === "bytes" :
              e.fn === "readable.flowing" ? t.kind === "bool" :
              t.kind === "object";
            const ok = def && def.arms.length === 2 &&
              def.arms.some(wantArm) && def.arms.some((a) => a.kind === "nullT");
            if (!ok) err(`libCall ${e.fn} must return its nullable union`, e.loc);
            break;
          }
          if (e.fn === "stream.prop") {
            if (e.type.kind !== "bool" && e.type.kind !== "f64") {
              err(`libCall stream.prop must be bool or f64, got ${e.type.kind}`, e.loc);
            }
            break;
          }
          if (!typeEquals(e.type, sig.result)) {
            err(`libCall ${e.fn} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        if (e.fn.startsWith("emitter.") && e.fn !== "emitter.setDefaultMax" &&
            e.fn !== "emitter.setDefaultMaxChk" &&
            e.fn !== "emitter.getDefaultMax" && e.fn !== "emitter.checkListener") {
          // Receiver: an emitter-hierarchy object (the %EventEmitter class
          // itself, or a class whose base chain reaches it). emitter.new
          // has no receiver — its RESULT is the bare emitter class.
          const isEmitterObject = (t: IrType | undefined): boolean => {
            if (t?.kind !== "object") return false;
            let name: string | undefined = t.className;
            while (name !== undefined) {
              if (name === RUNTIME_EMITTER_CLASS) return true;
              name = classes.get(name)?.base;
            }
            return false;
          };
          if (e.fn === "emitter.new") {
            if (e.type.kind !== "object" || e.type.className !== RUNTIME_EMITTER_CLASS) {
              err(`libCall emitter.new must return '%EventEmitter', got ${e.type.kind}`, e.loc);
            }
            break;
          }
          if (!isEmitterObject(e.args[0]?.type)) {
            err(`libCall ${e.fn} receiver must be an emitter-hierarchy object`, e.loc);
            break;
          }
          // The chaining forms return the receiver's own static class.
          if (e.fn === "emitter.on" || e.fn === "emitter.off" ||
              e.fn === "emitter.onDyn" || e.fn === "emitter.offDyn" ||
              e.fn === "emitter.onData" || e.fn === "emitter.onDataDyn" ||
              e.fn === "emitter.removeAll" || e.fn === "emitter.setMax" ||
              e.fn === "emitter.setMaxChk") {
            if (!typeEquals(e.type, e.args[0]!.type)) {
              err(`libCall ${e.fn} must return its receiver's type (the chaining 'this')`, e.loc);
            }
            // The listener slots carry closures (the dyn family's checked-
            // dynamic listener is table-checked; its adapter is a func).
            if ((e.fn === "emitter.on" || e.fn === "emitter.off" || e.fn === "emitter.onData") && e.args[2]?.type.kind !== "func") {
              err(`libCall ${e.fn} listener must be a func`, e.loc);
            }
            if ((e.fn === "emitter.onDyn" || e.fn === "emitter.onDataDyn") && e.args[3]?.type.kind !== "func") {
              err(`libCall ${e.fn} adapter must be a func`, e.loc);
            }
            break;
          }
          if (e.fn === "emitter.emitData") {
            const chunkT = e.args[2]?.type;
            const ok = chunkT !== undefined &&
              ((chunkT.kind === "bytes" && chunkT.elem === "u8") || chunkT.kind === "string");
            if (!ok) err(`libCall emitter.emitData chunk must be bytes<u8> or string`, e.loc);
            if (e.type.kind !== "bool") err(`libCall emitter.emitData must be bool`, e.loc);
            break;
          }
          if (e.fn === "emitter.countFn" && e.args[2]?.type.kind !== "func") {
            err(`libCall emitter.countFn listener must be a func`, e.loc);
            break;
          }
          if (e.fn === "emitter.emitError" && e.args[2]?.type.kind !== "object") {
            err(`libCall emitter.emitError payload must be an error-hierarchy object`, e.loc);
            break;
          }
          if (e.fn === "emitter.names") {
            const ok = e.type.kind === "array" && e.type.elem.kind === "string";
            if (!ok) err(`libCall emitter.names must return string[]`, e.loc);
            break;
          }
          if (e.fn === "emitter.listeners") {
            const ok = e.type.kind === "array" && e.type.elem.kind === "func";
            if (!ok) err(`libCall emitter.listeners must return a func array`, e.loc);
            break;
          }
          if (e.fn === "emitter.emit" || e.fn === "emitter.count" ||
              e.fn === "emitter.getMax" || e.fn === "emitter.ctor" ||
              e.fn === "emitter.countFn" || e.fn === "emitter.emitError") {
            if (!typeEquals(e.type, sig.result)) {
              err(`libCall ${e.fn} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
            }
            break;
          }
        }
        if (e.fn === "error.ctor" || e.fn === "error.toString") {
          const recv = e.args[0];
          const wantErrorRoot = e.fn === "error.toString";
          const ok =
            recv &&
            isBuiltinErrorObject(recv.type) &&
            (!wantErrorRoot || (recv.type.kind === "object" && recv.type.className === "%Error"));
          if (!ok) {
            err(
              `libCall ${e.fn} receiver must be ${wantErrorRoot ? "'%Error'" : "a builtin error class"}`,
              e.loc,
            );
          }
        }
        if (!typeEquals(e.type, sig.result)) {
          err(`libCall ${e.fn} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "jsonStringify": {
        checkExpr(e.value);
        if (e.type.kind !== "string") {
          err(`jsonStringify must be string, got ${e.type.kind}`, e.loc);
        }
        // The value's STATIC type drives the emitted serializer — it must be
        // JSON-safe (the frontend rejects the rest with a specific message).
        // A dyn ROOT is the one non-static shape allowed: the runtime's dyn
        // walker serializes it (scr_dyn_format_j), no emitted serializer.
        if (
          e.value.type.kind !== "dyn" &&
          !isJsonSafeType(e.value.type, (id) => records.get(id), (id) => unions.get(id))
        ) {
          err(`jsonStringify of non-JSON-safe type ${e.value.type.kind}`, e.loc);
        }
        break;
      }
      case "dynCheck": {
        checkExpr(e.value);
        expectType(e.value, DYN, "dynCheck operand");
        // The target drives the emitted validator/builder: non-dyn,
        // non-void, JSON-representable (closures/class instances can never
        // be found inside a JSON dyn — the frontend rejects those casts).
        // Bare undefined-armed unions of JSON-safe arms are additionally
        // valid: the checked-dynamic tree holds a first-class undefined value (overflow
        // reads), which matches exactly the undefined arm.
        const jsonOk = (t: IrType): boolean =>
          isJsonSafeType(t, (id) => records.get(id), (id) => unions.get(id));
        const undefArmedOk =
          e.type.kind === "union" &&
          (unions.get(e.type.unionId)?.arms.every((a) => a.kind === "undefinedT" || jsonOk(a)) ??
            false);
        // bytes<u8> targets extract the checked-dynamic tree's bytes kind (a copy).
        const bytesOk = e.type.kind === "bytes" && e.type.elem === "u8";
        // The %Error root extracts the checked-dynamic tree's error encoding (the "%error"
        // marker object caughtToDyn builds) as a fresh runtime error.
        const errorOk = e.type.kind === "object" && e.type.className === "%Error";
        // ADAPTABLE function targets unwrap or wrap the checked-dynamic tree's function
        // kind (the checked-dynamic function boundary, nodes.ts).
        const funcOk =
          e.type.kind === "func" &&
          canAdaptDynFuncTo(e.type, (id) => records.get(id), (id) => unions.get(id));
        // Runtime HANDLE targets unwrap the checked-dynamic tree's handle kind by tag (a
        // retained reference, no copy — DYN_HANDLE_KINDS).
        const handleOk = DYN_HANDLE_KINDS.has(e.type.kind);
        if (!jsonOk(e.type) && !undefArmedOk && !bytesOk && !errorOk && !funcOk && !handleOk) {
          err(`dynCheck against non-JSON-representable type ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "awaitExpr": {
        checkExpr(e.value);
        if (e.value.type.kind !== "promise") {
          err(`await of non-promise ${e.value.type.kind}`, e.loc);
        } else if (!typeEquals(e.type, e.value.type.inner)) {
          err(`await type ${e.type.kind} != promise inner ${e.value.type.inner.kind}`, e.loc);
        }
        if (!fn.async) err("await outside an async function", e.loc);
        break;
      }
      case "yieldExpr": {
        if (fn.generator === undefined) {
          err("yield outside a generator function", e.loc);
          break;
        }
        if (e.value === null) {
          err("yieldExpr with no operand (the frontend fills undefined)", e.loc);
          break;
        }
        checkExpr(e.value);
        if (!typeEquals(e.value.type, fn.generator.yieldT)) {
          err(`yield operand ${typeKey(e.value.type)} != yield channel ${typeKey(fn.generator.yieldT)}`, e.loc);
        }
        // The undefined next-channel has no C value form: such yields are
        // void-typed (statement position only — the frontend fences reads).
        if (fn.generator.nextT.kind === "undefinedT") {
          if (e.type.kind !== "void") err("yield result must be void on an undefined next-channel", e.loc);
        } else if (!typeEquals(e.type, fn.generator.nextT)) {
          err(`yield result ${typeKey(e.type)} != next channel ${typeKey(fn.generator.nextT)}`, e.loc);
        }
        break;
      }
      case "genResume": {
        checkExpr(e.gen);
        if (e.gen.type.kind !== "generator") {
          err(`genResume on ${e.gen.type.kind}`, e.loc);
          break;
        }
        const genT = e.gen.type;
        if (e.arg !== null) checkExpr(e.arg);
        if (e.mode === "next") {
          if (e.arg === null) {
            if (genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn") {
              err(`valueless next() on a ${typeKey(genT.nextT)} next-channel`, e.loc);
            }
          } else if (!typeEquals(e.arg.type, genT.nextT)) {
            err(`next argument ${typeKey(e.arg.type)} != next channel ${typeKey(genT.nextT)}`, e.loc);
          }
        } else if (e.mode === "return") {
          if (e.arg !== null && !typeEquals(e.arg.type, genT.retT)) {
            err(`return argument ${typeKey(e.arg.type)} != return channel ${typeKey(genT.retT)}`, e.loc);
          }
        } else {
          // throw: any exception-representable payload (the throw
          // statement's rule). Date cannot retain its object kind in the
          // untyped exception cell.
          if (e.arg === null) {
            err("genResume throw with no payload", e.loc);
          } else if (
            e.arg.type.kind === "void" ||
            e.arg.type.kind === "dyn" ||
            e.arg.type.kind === "caught" ||
            e.arg.type.kind === "date"
          ) {
            err(`genResume throw of a ${e.arg.type.kind} value`, e.loc);
          }
        }
        // The result is the IteratorResult record { done: bool, value: V }
        // with V dyn (the any/unknown channel) or an undefined-armed union.
        if (e.type.kind !== "record") {
          err(`genResume result is ${e.type.kind}, not a record`, e.loc);
          break;
        }
        const rec = records.get(e.type.shapeId);
        const doneF = rec?.fields.find((f) => f.name === "done");
        const valueF = rec?.fields.find((f) => f.name === "value");
        if (!rec || rec.fields.length !== 2 || doneF?.type.kind !== "bool" || valueF === undefined) {
          err(`genResume result record ${e.type.shapeId} is not { done: bool, value: V }`, e.loc);
          break;
        }
        if (valueF.type.kind === "dyn") break;
        const vdef = valueF.type.kind === "union" ? unions.get(valueF.type.unionId) : undefined;
        if (!vdef || !vdef.arms.some((a) => a.kind === "undefinedT")) {
          err(`genResume value slot ${typeKey(valueF.type)} is neither dyn nor an undefined-armed union`, e.loc);
        }
        break;
      }
      case "awaitUnionExpr": {
        checkExpr(e.value);
        const def = e.value.type.kind === "union" ? unions.get(e.value.type.unionId) : undefined;
        const promiseArm = def?.arms[e.promiseTag];
        if (!def) {
          err(`awaitUnion of non-union ${e.value.type.kind}`, e.loc);
        } else if (promiseArm?.kind !== "promise") {
          err(`awaitUnion arm ${e.promiseTag} is not a promise`, e.loc);
        } else if (!def.arms.every((a, i) => i === e.promiseTag || isUnitType(a))) {
          err("awaitUnion union has non-unit arms beside the promise", e.loc);
        } else if (e.type.kind === "void") {
          if (promiseArm.inner.kind !== "void") {
            err("awaitUnion void result over a value-carrying promise", e.loc);
          }
        } else if (e.type.kind !== "union") {
          err(`awaitUnion result is ${e.type.kind}, not void or a union`, e.loc);
        } else {
          const res = unions.get(e.type.unionId);
          const covered =
            res &&
            res.arms.some((a) => typeEquals(a, promiseArm.inner)) &&
            def.arms.every(
              (a, i) => i === e.promiseTag || res.arms.some((b) => typeEquals(a, b)),
            );
          if (!covered) err("awaitUnion result union misses an arm", e.loc);
        }
        if (!fn.async) err("await outside an async function", e.loc);
        break;
      }
      case "newPromise": {
        checkExpr(e.executor);
        if (e.type.kind !== "promise") {
          err("newPromise must have promise type", e.loc);
          break;
        }
        const inner = e.type.inner;
        const exec = e.executor.type;
        if (exec.kind !== "func" || exec.params.length > 2) {
          err("newPromise executor must be (resolve?, reject?) => void", e.loc);
          break;
        }
        if (exec.params.length === 2) {
          // The reject closure's one shape: (reason: %Error) => void.
          const rj = exec.params[1]!;
          if (
            rj.kind !== "func" ||
            rj.ret.kind !== "void" ||
            rj.params.length !== 1 ||
            rj.params[0]!.kind !== "object" ||
            rj.params[0]!.className !== "%Error"
          ) {
            err("newPromise reject param must be (%Error) => void", e.loc);
          }
        }
        if (exec.params.length >= 1) {
          const rp = exec.params[0]!;
          if (rp.kind !== "func" || rp.ret.kind !== "void") {
            err("newPromise resolve must be a void-returning function", e.loc);
            break;
          }
          const expectsArg = inner.kind !== "void";
          if (expectsArg && (rp.params.length !== 1 || !typeEquals(rp.params[0]!, inner))) {
            err(`newPromise resolve param must be (${inner.kind}) => void`, e.loc);
          }
          if (!expectsArg && rp.params.length !== 0) {
            err("newPromise<void> resolve takes no argument", e.loc);
          }
        }
        break;
      }
      case "promiseWithResolvers": {
        // The record shape: promise: Promise<T>, resolve: (T) => void
        // (() => void when T is void), reject: (%Error) => void.
        if (e.type.kind !== "record") {
          err("promiseWithResolvers must have record type", e.loc);
          break;
        }
        const shape = records.get(e.type.shapeId);
        const fields = new Map(shape?.fields.map((f) => [f.name, f.type]) ?? []);
        const prom = fields.get("promise");
        const resolve = fields.get("resolve");
        const reject = fields.get("reject");
        if (!shape || shape.fields.length !== 3 || !prom || !resolve || !reject) {
          err("promiseWithResolvers record must be { promise, resolve, reject }", e.loc);
          break;
        }
        if (prom.kind !== "promise") {
          err("promiseWithResolvers promise field must be a promise", e.loc);
          break;
        }
        const inner = prom.inner;
        if (resolve.kind !== "func" || resolve.ret.kind !== "void") {
          err("promiseWithResolvers resolve must be a void-returning function", e.loc);
        } else if (inner.kind === "void" ? resolve.params.length !== 0
                 : resolve.params.length !== 1 || !typeEquals(resolve.params[0]!, inner)) {
          err(`promiseWithResolvers resolve param must match the promise's inner type`, e.loc);
        }
        if (
          reject.kind !== "func" ||
          reject.ret.kind !== "void" ||
          reject.params.length !== 1 ||
          reject.params[0]!.kind !== "object" ||
          reject.params[0]!.className !== "%Error"
        ) {
          err("promiseWithResolvers reject must be (%Error) => void", e.loc);
        }
        break;
      }
      case "jsMarshal": {
        checkExpr(e.value);
        if (e.type.kind !== "jsval") err(`jsMarshal must be jsval, got ${e.type.kind}`, e.loc);
        const src = e.value.type;
        // The marshal direction admits qualifying closures (host-function
        // wrapping) on top of the JSON-safe set; jsExit does not. Typed
        // closures (per-param call-time conversion through the exit
        // machinery) are the wider func shape.
        // Typed arrays and URLs marshal IN (an engine typed-array copy /
        // an engine URL built from the components) without ever joining
        // the round-trip (JSON) set — the frontend's union lift narrows
        // union arms before marshaling, so bare bytes/url operands are
        // exactly what it produces.
        if (
          src.kind !== "bytes" &&
          src.kind !== "url" &&
          src.kind !== "dyn" && // dyn values deep-copy in (data kinds; the runtime throws on boxes)
          // A STATIC promise crosses as a real engine thenable when its
          // fulfillment is in the reverse bridge's payload domain
          // (scr_jsval_from_promise — the async-callback return bridge).
          !(src.kind === "promise" && islandPromisePayloadTag(src.inner) !== null) &&
          !canMarshalIntoIsland(src, (id) => records.get(id), (id) => unions.get(id)) &&
          !canMarshalTypedFuncIntoIsland(src, (id) => records.get(id), (id) => unions.get(id))
        ) {
          err(`jsMarshal of unmarshalable type ${src.kind}`, e.loc);
        }
        break;
      }
      case "jsOp": {
        for (const a of e.args) checkExpr(a);
        if (e.type.kind !== jsOpResultKind(e.op)) {
          err(`jsOp ${e.op} must be ${jsOpResultKind(e.op)}, got ${e.type.kind}`, e.loc);
        }
        const named =
          e.op === "getProp" || e.op === "setProp" || e.op === "callMethod" || e.op === "optCallMethod" || e.op === "globalGet" ||
          e.op === "callSpread"; // the spread expression's source spelling (V8's nullish text spells it)
        if (named !== (e.name !== undefined)) {
          err(`jsOp ${e.op} ${named ? "requires" : "forbids"} a name`, e.loc);
        }
        const arity: Record<string, number | null> = {
          add: 2, sub: 2, mul: 2, div: 2, mod: 2, pow: 2,
          lt: 2, le: 2, gt: 2, ge: 2, eq: 2, neq: 2, instanceOf: 2,
          neg: 1, plus: 1, truthy: 1, not: 1, typeof: 1, toStr: 1,
          getProp: 1, setProp: 2, getIdx: 2, setIdx: 3, globalGet: 0,
          undefLit: 0, nullLit: 0, iterNew: 1, defineGetter: 3, objSpread: 2,
          callSpread: 3, // callee + pre array + spread source
          callMethod: null, optCallMethod: null, callFn: null, callFnThis: null, construct: null, // receiver/callee + any number of args
          objLit: null, arrLit: null, tplStrings: null, // variable length (objLit: key/value pairs; tplStrings: n cooked + n raw)
        };
        const want = arity[e.op];
        if (want !== null && want !== undefined && e.args.length !== want) {
          err(`jsOp ${e.op} takes ${want} arg(s), got ${e.args.length}`, e.loc);
        }
        if (want === null && e.op !== "objLit" && e.op !== "arrLit" && e.op !== "tplStrings" && e.args.length < 1) {
          err(`jsOp ${e.op} needs a receiver/callee arg`, e.loc);
        }
        if (e.op === "callFnThis" && e.args.length < 2) {
          err("jsOp callFnThis needs a callee and receiver", e.loc);
        }
        if (e.op === "objLit" && e.args.length % 2 !== 0) {
          err("jsOp objLit takes key/value pairs", e.loc);
        }
        if (e.op === "tplStrings" && e.args.length % 2 !== 0) {
          err("jsOp tplStrings takes n cooked + n raw strings", e.loc);
        }
        for (const a of e.args) {
          if (a.type.kind !== "jsval") err(`jsOp ${e.op} arg must be jsval, got ${a.type.kind}`, e.loc);
        }
        break;
      }
      case "jsExit": {
        checkExpr(e.value);
        expectType(e.value, JSVAL, "jsExit operand");
        if (!canExitIslandToType(e.type, (id) => records.get(id), (id) => unions.get(id))) {
          err(`jsExit to non-extractable type ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "jsBridgePromise": {
        checkExpr(e.value);
        expectType(e.value, JSVAL, "jsBridgePromise operand");
        // The settled engine value crosses as a HANDLE (or not at all) —
        // plus the ONE converting payload: an `any[]`-declared
        // fulfillment exits Array.isArray-gated by reference AT THE
        // SETTLE (SCR_ISLP_JSVAL_ARR); every other typed use exits later.
        if (
          e.type.kind !== "promise" ||
          (e.type.inner.kind !== "jsval" &&
            e.type.inner.kind !== "void" &&
            !(e.type.inner.kind === "array" && e.type.inner.elem.kind === "jsval"))
        ) {
          err("jsBridgePromise must be a promise of jsval, void, or jsval-element array", e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  // `continue` needs an enclosing loop; `break` an enclosing loop OR switch.
  let loopDepth = 0;
  let breakableDepth = 0;
  // Labeled jump targets, innermost last: every loop/switch/labeled-block
  // enters with its labels (possibly none) so `break lbl`/`continue lbl`
  // can resolve to an enclosing entry — and so the finally backstop can
  // compare the TARGET's position, not just the innermost depth.
  const labelTargets: { kind: "loop" | "switch" | "block"; labels: string[] }[] = [];
  // Active try-with-finally regions: break/continue may not cross one, and
  // NO jump may leave a finally BODY (the frontend fences both; this is the
  // backstop). `return` crossing a region is modeled now (the backend's
  // pending-return path), so returns are legal in tryBody/catchBody but
  // still rejected inside finallyBody (they would replace a pending
  // completion). Each entry records the loop/switch depths (and the label
  // stack length) at region entry: a break whose target is at or below
  // them would cross the finally.
  const finallyRegions: { loopDepth: number; breakableDepth: number; labelLen: number }[] = [];
  let finallyBlockDepth = 0;

  function checkStmts(stmts: IrStmt[]): void {
    for (const s of stmts) checkStmt(s);
  }

  function checkLoopBody(stmts: IrStmt[], labels: string[] | undefined): void {
    loopDepth++;
    breakableDepth++;
    labelTargets.push({ kind: "loop", labels: labels ?? [] });
    checkStmts(stmts);
    labelTargets.pop();
    breakableDepth--;
    loopDepth--;
  }

  /** The innermost enclosing target carrying `label`, or null — plus its
   * index for the finally-region crossing check. */
  function labelTargetOf(label: string): { entry: (typeof labelTargets)[number]; index: number } | null {
    for (let i = labelTargets.length - 1; i >= 0; i--) {
      if (labelTargets[i]!.labels.includes(label)) return { entry: labelTargets[i]!, index: i };
    }
    return null;
  }

  function checkStmt(s: IrStmt): void {
    switch (s.kind) {
      case "varDecl": {
        const local = locals.get(s.localId);
        if (!local) err(`varDecl of undeclared local "${s.localId}"`, s.loc);
        // Catch bindings are introduced by tryCatch alone.
        if (local?.type.kind === "caught") err(`varDecl of caught-typed local "${s.localId}"`, s.loc);
        if (s.init === null) {
          // Declared, uninitialized: reads before assignment are impossible
          // (tsc TS2454); an uninitialized immutable local is nonsense —
          // EXCEPT a TDZ const (forward-captured): its box is allocated
          // empty at scope entry and the source declaration assigns once.
          if (local && !local.mutable && !local.tdz) {
            err(`varDecl "${local.name}" has no init but is immutable`, s.loc);
          }
          break;
        }
        checkExpr(s.init);
        if (local) expectType(s.init, local.type, `varDecl "${local.name}" init`);
        break;
      }
      case "assign": {
        const binding = locals.get(s.localId) ?? globals.get(s.localId);
        if (!binding) err(`assign to undeclared local/global "${s.localId}"`, s.loc);
        // Global initialization happens via assign inside %init functions,
        // so a const global legitimately receives exactly one assign there;
        // tsc rejects user reassignment of consts, and the lowerer only
        // emits the init-time one. Locals keep the strict check — except a
        // TDZ const, whose source declaration IS an assign into the
        // scope-entry box (tsc rejects user reassignment there too).
        else if (!binding.mutable && locals.has(s.localId) && !("tdz" in binding && binding.tdz)) {
          err(`assign to immutable local "${binding.name}"`, s.loc);
        }
        if (binding?.type.kind === "caught") {
          err(`assign to catch binding "${binding.name}" (frontend must reject)`, s.loc);
        }
        checkExpr(s.value);
        if (binding) expectType(s.value, binding.type, `assign "${binding.name}"`);
        break;
      }
      case "exprStmt":
        checkExpr(s.expr);
        break;
      case "if":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "if condition");
        checkStmts(s.then);
        if (s.else_) checkStmts(s.else_);
        break;
      case "while":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "while condition");
        checkLoopBody(s.body, s.labels);
        break;
      case "doWhile":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "do-while condition");
        checkLoopBody(s.body, s.labels);
        break;
      case "switch": {
        checkExpr(s.disc);
        const dk = s.disc.type.kind;
        if (dk !== "f64" && dk !== "string" && dk !== "bool") {
          err(`switch discriminant must be f64|string|bool, got ${dk}`, s.loc);
        }
        let defaults = 0;
        for (const c of s.cases) {
          if (c.test === null) {
            defaults++;
          } else {
            checkExpr(c.test);
            expectType(c.test, s.disc.type, "switch case test");
          }
          // Case bodies: `break` binds here, `continue` does not.
          breakableDepth++;
          labelTargets.push({ kind: "switch", labels: s.labels ?? [] });
          checkStmts(c.body);
          labelTargets.pop();
          breakableDepth--;
        }
        if (defaults > 1) err(`switch has ${defaults} default clauses`, s.loc);
        break;
      }
      case "for":
        if (s.init) checkStmt(s.init);
        if (s.cond) {
          checkExpr(s.cond);
          expectType(s.cond, BOOL, "for condition");
        }
        if (s.update) checkStmt(s.update);
        checkLoopBody(s.body, s.labels);
        break;
      case "arraySet": {
        checkExpr(s.arr);
        checkExpr(s.index);
        checkExpr(s.value);
        expectType(s.index, F64, "arraySet index");
        if (s.arr.type.kind !== "array") {
          err(`arraySet on non-array ${s.arr.type.kind}`, s.loc);
        } else {
          expectType(s.value, s.arr.type.elem, "arraySet value");
        }
        break;
      }
      case "bytesSet": {
        checkExpr(s.arr);
        checkExpr(s.index);
        checkExpr(s.value);
        expectType(s.index, F64, "bytesSet index");
        expectType(s.value, F64, "bytesSet value");
        if (s.arr.type.kind !== "bytes") {
          err(`bytesSet on non-bytes ${s.arr.type.kind}`, s.loc);
        }
        break;
      }
      case "fieldSet": {
        checkExpr(s.obj);
        checkExpr(s.value);
        const cls = classes.get(s.className);
        const field = cls?.fields.find((f) => f.name === s.field);
        if (!cls) err(`fieldSet on undeclared class "${s.className}"`, s.loc);
        else if (!field) err(`class ${s.className} has no field "${s.field}"`, s.loc);
        else {
          expectType(s.obj, { kind: "object", className: s.className }, "fieldSet receiver");
          expectType(s.value, field.type, `fieldSet ${s.className}.${s.field}`);
        }
        break;
      }
      case "recordSet": {
        checkExpr(s.obj);
        checkExpr(s.value);
        const shape = records.get(s.shapeId);
        const field = shape?.fields.find((f) => f.name === s.field);
        if (!shape) err(`recordSet on undeclared shape "${s.shapeId}"`, s.loc);
        else if (!field) err(`shape ${s.shapeId} has no field "${s.field}"`, s.loc);
        else {
          expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordSet receiver");
          expectType(s.value, field.type, `recordSet ${s.shapeId}.${s.field}`);
        }
        break;
      }
      case "recordKeyDelete": {
        checkExpr(s.obj);
        checkExpr(s.key);
        const shape = records.get(s.shapeId);
        if (!shape) {
          err(`recordKeyDelete on undeclared shape "${s.shapeId}"`, s.loc);
          break;
        }
        if (!shape.indexValue || shape.fields.length > 0) {
          err(`recordKeyDelete on non-pure-index-signature shape ${s.shapeId}`, s.loc);
          break;
        }
        expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeyDelete receiver");
        expectType(s.key, STRING, "recordKeyDelete key");
        break;
      }
      case "recordKeySet": {
        checkExpr(s.obj);
        checkExpr(s.key);
        checkExpr(s.value);
        const shape = records.get(s.shapeId);
        if (!shape) {
          err(`recordKeySet on undeclared shape "${s.shapeId}"`, s.loc);
          break;
        }
        if (!shape.indexValue) {
          // Signature-free dispatch: every declared field shares ONE type
          // (the frontend's gate), the value IS that type, and a key miss
          // traps at runtime — so overflowOnly writes cannot exist here.
          const common = shape.fields[0]?.type;
          if (!common || !shape.fields.every((f) => typeEquals(f.type, common))) {
            err(`recordKeySet on non-index-signature shape ${s.shapeId} without one shared field type`, s.loc);
            break;
          }
          if (s.overflowOnly) {
            err(`recordKeySet overflowOnly on signature-free shape ${s.shapeId}`, s.loc);
          }
          expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeySet receiver");
          expectType(s.key, STRING, "recordKeySet key");
          expectType(s.value, common, "recordKeySet value");
          break;
        }
        expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeySet receiver");
        expectType(s.key, STRING, "recordKeySet key");
        expectType(s.value, shape.indexValue, "recordKeySet value");
        // A dyn value validates against declared fields at runtime; typed
        // values need every declared field to BE the index-value type (the
        // write-through stores directly). overflowOnly writes (a literal
        // key naming no declared field) never collide and skip the check.
        if (
          !s.overflowOnly &&
          shape.indexValue.kind !== "dyn" &&
          !shape.fields.every((f) => typeEquals(f.type, shape.indexValue!))
        ) {
          err(`recordKeySet on ${s.shapeId}: declared fields differ from the index-value type`, s.loc);
        }
        break;
      }
      case "forOf": {
        const local = locals.get(s.localId);
        if (!local) err(`forOf with undeclared local "${s.localId}"`, s.loc);
        checkExpr(s.iterable);
        if (s.iterable.type.kind !== "array") {
          err(`forOf over non-array ${s.iterable.type.kind}`, s.loc);
        } else if (local && !typeEquals(local.type, s.iterable.type.elem)) {
          err(
            `forOf local "${local.name}" type ${local.type.kind} != element ${s.iterable.type.elem.kind}`,
            s.loc,
          );
        }
        checkLoopBody(s.body, s.labels);
        break;
      }
      case "block":
        if (s.labels !== undefined) {
          // A labeled block is a break-only jump target.
          labelTargets.push({ kind: "block", labels: s.labels });
          checkStmts(s.body);
          labelTargets.pop();
        } else {
          checkStmts(s.body);
        }
        break;
      case "throw":
        checkExpr(s.value);
        // dyn throws are allowed: the dyn node rides the REF cell arm by
        // reference (the JS-lane `throw err` of a dyn argument).
        if (s.value.type.kind === "void" || s.value.type.kind === "caught" || s.value.type.kind === "date") {
          err(`throw of a ${s.value.type.kind} value`, s.loc);
        }
        break;
      case "runtimeFence":
        // The deferred JS compile fence: carries only its message/code.
        if (s.message.length === 0) err(`runtimeFence with an empty message`, s.loc);
        break;
      case "rethrow": {
        // `throw e` of a catch binding: re-raises the saved snapshot.
        const local = locals.get(s.localId);
        if (!local) err(`rethrow of undeclared local "${s.localId}"`, s.loc);
        else if (local.type.kind !== "caught") {
          err(`rethrow of non-caught local "${s.localId}" (${local.type.kind})`, s.loc);
        }
        break;
      }
      case "tryCatch": {
        if (s.catchBody === null && s.finallyBody === null) {
          err(`tryCatch with neither catch nor finally`, s.loc);
        }
        if (s.catchLocalId !== null) {
          const cl = locals.get(s.catchLocalId);
          if (!cl) err(`tryCatch catch binding "${s.catchLocalId}" has no local entry`, s.loc);
          else if (cl.type.kind !== "caught") {
            err(`tryCatch catch binding "${s.catchLocalId}" is ${cl.type.kind}, not caught`, s.loc);
          }
          if (s.catchBody === null) {
            err(`tryCatch catch binding without a catch body`, s.loc);
          }
        }
        const guarded = s.finallyBody !== null;
        if (guarded) finallyRegions.push({ loopDepth, breakableDepth, labelLen: labelTargets.length });
        checkStmts(s.tryBody);
        if (s.catchBody) checkStmts(s.catchBody);
        if (s.finallyBody) {
          finallyBlockDepth++;
          checkStmts(s.finallyBody);
          finallyBlockDepth--;
        }
        if (guarded) finallyRegions.pop();
        break;
      }
      case "break": {
        const region = finallyRegions[finallyRegions.length - 1];
        if (s.label !== undefined) {
          const target = labelTargetOf(s.label);
          if (!target) err(`break to unknown label "${s.label}"`, s.loc);
          else if (region && target.index < region.labelLen) {
            err(`labeled break crossing a finally block (frontend must reject)`, s.loc);
          }
          break;
        }
        if (breakableDepth === 0) err(`break outside a loop or switch`, s.loc);
        if (region && breakableDepth <= region.breakableDepth) {
          err(`break crossing a finally block (frontend must reject)`, s.loc);
        }
        break;
      }
      case "continue": {
        const region = finallyRegions[finallyRegions.length - 1];
        if (s.label !== undefined) {
          const target = labelTargetOf(s.label);
          if (!target) err(`continue to unknown label "${s.label}"`, s.loc);
          else if (target.entry.kind !== "loop") {
            err(`continue to non-loop label "${s.label}"`, s.loc);
          } else if (region && target.index < region.labelLen) {
            err(`labeled continue crossing a finally block (frontend must reject)`, s.loc);
          }
          break;
        }
        if (loopDepth === 0) err(`continue outside a loop`, s.loc);
        if (region && loopDepth <= region.loopDepth) {
          err(`continue crossing a finally block (frontend must reject)`, s.loc);
        }
        break;
      }
      case "return":
        // Crossing OUT of a try/catch body guarded by a finally is modeled
        // (the backend's pending-return path); a return inside the finally
        // BODY itself is not (it would replace a pending completion).
        if (finallyBlockDepth > 0) {
          err(`return inside a finally body (frontend must reject)`, s.loc);
        }
        if (s.value) {
          checkExpr(s.value);
          expectType(s.value, fn.returnType, "return value");
        } else if (!typeEquals(fn.returnType, VOID)) {
          err(`bare return in non-void function`, s.loc);
        }
        break;
      default: {
        const _exhaustive: never = s;
        void _exhaustive;
      }
    }
  }

  checkStmts(fn.body);

  if (!typeEquals(fn.returnType, VOID) && !alwaysReturns(fn.body, unions)) {
    err(`non-void function may complete without returning`, fn.loc);
  }
}

/** Conservative "all paths return" — mirrors what tsc already guarantees. */
function alwaysReturns(stmts: IrStmt[], unions: Map<string, IrUnionDef>): boolean {
  for (const s of stmts) {
    switch (s.kind) {
      case "return":
        return true;
      case "throw":
      case "rethrow":
      case "runtimeFence":
        // Terminates the path like return: control unwinds (to a handler or
        // out of the function), never falling off the end. tsc agrees —
        // `function f(): T { throw x; }` typechecks without a return.
        return true;
      case "exprStmt":
        // process.exit never returns (fflush + _Exit): the path terminates
        // like a throw. Mirrors tsc's own never-based reachability, which
        // accepted the function without a trailing return — the
        // parseAsync().catch entry handler ends exactly this way.
        if (s.expr.kind === "libCall" && s.expr.fn === "process.exit") return true;
        break;
      case "tryCatch":
        // Normal completion requires the try body to complete normally (and
        // the catch, when the try raised) — if both always terminate, so
        // does the whole statement. Without a catch, an exception keeps
        // propagating (never a normal completion), so the try body alone
        // decides. A finally that always terminates (throw) also decides.
        if (
          alwaysReturns(s.tryBody, unions) &&
          (s.catchBody === null || alwaysReturns(s.catchBody, unions))
        ) {
          return true;
        }
        if (s.finallyBody && alwaysReturns(s.finallyBody, unions)) return true;
        break;
      case "if":
        if (s.else_ && alwaysReturns(s.then, unions) && alwaysReturns(s.else_, unions)) return true;
        break;
      case "while":
        // `while (true)` with no break never completes normally (tsc treats
        // it the same way), so anything after it is unreachable.
        if (s.cond.kind === "boolLit" && s.cond.value && !containsBreak(s.body)) return true;
        break;
      case "for":
        // `for (;;)` — no condition, or a literal-true one — with no break
        // never completes normally either (the walk-up-until-root idiom:
        // every exit is a return).
        if (
          (s.cond === null || (s.cond.kind === "boolLit" && s.cond.value)) &&
          !containsBreak(s.body)
        ) {
          return true;
        }
        break;
      case "block":
        if (alwaysReturns(s.body, unions)) return true;
        break;
      case "doWhile":
        // The body runs at least once: if it returns on all paths, so does
        // the loop. `do {} while (true)` with no break never completes.
        if (alwaysReturns(s.body, unions)) return true;
        if (s.cond.kind === "boolLit" && s.cond.value && !containsBreak(s.body)) return true;
        break;
      case "switch": {
        // A switch always returns when no case body ever breaks out, every
        // possible entry point (any case) reaches a return, and dispatch
        // cannot miss every case: either a default exists, or the switch is
        // an EXHAUSTIVE discriminant switch — the discriminant is a
        // `unionDisc` over a union with N arms, every test is a distinct
        // literal, and there are at least N of them. (At least: several
        // discriminant VALUES can share one deduped IR arm, e.g.
        // `{op: 0; a} | {op: 2; a}` is one record shape.) The real
        // exhaustiveness guarantee is tsc's — it accepted the function
        // without a trailing return (trust-the-checker, like narrowing
        // itself); this condition only keeps hand-written IR conservative.
        // With no switch-level breaks, execution from case i runs bodies
        // i..end as a straight line — check that flattened suffix.
        const hasDefault = s.cases.some((c) => c.test === null);
        const literalTests = s.cases.map((c) => c.test).filter(
          (t): t is IrExpr & { kind: "numLit" | "strLit" | "boolLit" } =>
            t !== null && (t.kind === "numLit" || t.kind === "strLit" || t.kind === "boolLit"),
        );
        const distinct = new Set(literalTests.map((t) => `${t.kind}:${String(t.value)}`));
        const exhaustive =
          !hasDefault &&
          s.disc.kind === "unionDisc" &&
          literalTests.length === s.cases.length &&
          distinct.size === s.cases.length &&
          s.cases.length >= (unions.get(s.disc.unionId)?.arms.length ?? Infinity);
        if (!hasDefault && !exhaustive) break;
        if (s.cases.some((c) => containsBreak(c.body))) break;
        const bodies = s.cases.map((c) => c.body);
        const everyEntryReturns = bodies.every((_, i) =>
          alwaysReturns(bodies.slice(i).flat(), unions),
        );
        if (everyEntryReturns) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

/** Break at this level (not inside a nested loop or switch, whose bodies
 * own their breaks). */
function containsBreak(stmts: IrStmt[]): boolean {
  for (const s of stmts) {
    switch (s.kind) {
      case "break":
        return true;
      case "if":
        if (containsBreak(s.then) || (s.else_ && containsBreak(s.else_))) return true;
        break;
      case "block":
        if (containsBreak(s.body)) return true;
        break;
      case "tryCatch":
        // Plain try/catch does not capture breaks — a break inside binds to
        // the enclosing loop/switch (finally-crossing jumps are rejected
        // upstream, so reachable IR only has these in plain try/catch).
        if (
          containsBreak(s.tryBody) ||
          (s.catchBody !== null && containsBreak(s.catchBody)) ||
          (s.finallyBody !== null && containsBreak(s.finallyBody))
        ) {
          return true;
        }
        break;
      default:
        break; // while/for/doWhile/switch bodies own their breaks
    }
  }
  return false;
}
