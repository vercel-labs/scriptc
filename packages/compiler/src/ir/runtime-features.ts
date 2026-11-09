import {
  BIGINT_BYTES_NAMES,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrRecordShape,
  type IrType,
  type IrUnionDef,
} from "./ir.js";
import type { IrLibFn } from "./builtin-signatures.js";
import {
  isDirentShape,
  recordHandleCodecClass,
  recordTextCodecClass,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  RUNTIME_STREAM_CLASSES,
} from "./ir.js";
import { everyModuleNode, everyStmtList } from "./traverse.js";
import { isDeferredDiagnosticFence } from "./deferred-fence.js";
import { eachNodeOfKinds, type IrNodeIndex } from "./node-index.js";
import { JsIcSites, hasJsIcSite } from "./js-ic.js";
import { TEXT_DECODER_STREAM_CLASS } from "./webstream-classes.js";

const DYN_BUFFER_NUM_METHODS: ReadonlySet<string> = new Set(
  ["read", "write"].flatMap((rw) => [
    ...["UInt", "Uint"].flatMap((u) =>
      ["8", "16LE", "16BE", "32LE", "32BE"].map((w) => `${rw}${u}${w}`),
    ),
    ...[
      "Int8",
      "Int16LE",
      "Int16BE",
      "Int32LE",
      "Int32BE",
      "FloatLE",
      "FloatBE",
      "DoubleLE",
      "DoubleBE",
    ].map((n) => `${rw}${n}`),
  ]),
);

/** The variable-width and BigInt reads and writes, which
 * scr_dyn_invoke_buffer_wide runs. */
const DYN_BUFFER_WIDE_METHODS: readonly string[] = ["read", "write"].flatMap((rw) => [
  ...["UIntLE", "UIntBE", "UintLE", "UintBE", "IntLE", "IntBE"].map((n) => `${rw}${n}`),
  ...["BigUInt64", "BigUint64", "BigInt64"].flatMap((n) => [`${rw}${n}LE`, `${rw}${n}BE`]),
]);

/** The Buffer.prototype members scr_dyn_invoke_buffer refuses on Buffer
 * receivers besides running the named ones: the per-encoding slices and
 * writes, and inspect. */
const DYN_BUFFER_FAMILY_METHODS: readonly string[] = [
  ...["ascii", "base64", "base64url", "latin1", "hex", "ucs2", "utf8"].flatMap((enc) => [
    `${enc}Slice`,
    `${enc}Write`,
  ]),
  "inspect",
];

/** The scr_bytes_dyn.c entry, one per method family, that a checked-dynamic
 * call of a Buffer.prototype method name routes to: the fixed-width reads and
 * writes (both "UInt" and "Uint" spellings), the variable-width and BigInt
 * ones, write, fill, toString, the searches, and the other Buffer-only
 * members. Each runs the method on a Buffer receiver and gives any other
 * receiver the ordinary dispatch. */
export const DYN_BUFFER_METHODS: ReadonlyMap<string, string> = new Map([
  ...[...DYN_BUFFER_NUM_METHODS].map((m): [string, string] => [m, "scr_dyn_invoke_buffer_num"]),
  ...DYN_BUFFER_WIDE_METHODS.map((m): [string, string] => [m, "scr_dyn_invoke_buffer_wide"]),
  ["write", "scr_dyn_invoke_buffer_write"],
  ["fill", "scr_dyn_invoke_buffer_fill"],
  ["toString", "scr_dyn_invoke_buffer_to_string"],
  ...["indexOf", "lastIndexOf", "includes"].map((m): [string, string] => [
    m,
    "scr_dyn_invoke_buffer_search",
  ]),
  ...[
    "toJSON",
    "equals",
    "compare",
    "copy",
    "swap16",
    "swap32",
    "swap64",
    ...DYN_BUFFER_FAMILY_METHODS,
  ].map((m): [string, string] => [m, "scr_dyn_invoke_buffer"]),
]);

const DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  // A typed promise's resolve function given a promise (scr_resolve_adopt,
  // beside the checked-dynamic resolution it shares its target box with).
  "promise.adopt",
  // DEP0040 rides the dyn-async unit's warning machinery.
  "async.awaitDyn",
  // So does SlowBuffer's DEP0030.
  "buffer.slowBuffer",
  // The handle property table adopts child thenables through the dyn-async
  // unit.
  "handle.propsInstall",
  "child.propsResolve",
  "crypto.native",
  // The crypto global's object extends crypto.native's.
  "webcrypto.object",
  // Web streams settle their promises with dyn values.
  "webstream.class",
  "webstream.from",
  "webstream.instanceOf",
  "webstream.install",
  "dyn.promiseAll",
  "dyn.promiseAllSettled",
  "dyn.promiseAny",
  "dyn.promiseResolve",
  // A promise boxed as a weak collection's key (scr_dyn_new_promise).
  "weakMap.promiseKey",
  // The generic Promise statics build and settle their capability's promise
  // with dyn values (scr_dyn_new_promise, scr_dyn_promise_resolve).
  "promise.genericStatic",
  "fs.callbackCall",
  "fs.callbackGlob",
  "fs.callbackValue",
  "process.deprecationFlag",
  "process.emitWarning",
  "process.emitWarningText",
  "process.offRejectionHandled",
  "process.offUncaughtException",
  "process.offUnhandledRejection",
  "process.offWarning",
  "process.onRejectionHandled",
  "process.onUncaughtException",
  "process.prependUncaughtException",
  "process.onUnhandledRejection",
  "process.onWarning",
  "process.setDeprecationFlag",
  "process.setEmitWarning",
  "punycode.warn",
  // DEP0005 for the deprecated Buffer constructor.
  "buffer.deprecation",
  // util.aborted answers a checked-dynamic promise, and so do the
  // functions util.debounce and util.throttle return.
  "util.aborted",
  "util.debounce",
  "util.throttle",
  "timers.immediatePromise",
  // A timer callback bound to its handle as `this`.
  "timers.thisCallback",
  // The performance timeline (scr_perf.c, linked with this unit for its
  // MaxPerformanceEntryBufferExceededWarning).
  "perf.clearMarks",
  "perf.clearMeasures",
  "perf.entries",
  "perf.entryDetail",
  "perf.entryDuration",
  "perf.entryKeep",
  "perf.entryName",
  "perf.entryRef",
  "perf.entryStart",
  "perf.entryType",
  "perf.mark",
  "perf.measure",
  // Blob and File (scr_blob.c, linked with this unit, which boxes their
  // reads as dyn promises).
  "als.bindCallbackDyn",
  "als.disable",
  "als.enterWith",
  "als.exitRun",
  "als.get",
  "als.name",
  "als.new",
  "als.newOptions",
  "als.run",
  "als.snapshot",
  "blob.arrayBuffer",
  "blob.bytes",
  "blob.fileNew",
  "blob.is",
  "blob.new",
  "blob.slice",
  "blob.text",
  "dc.chanBindStore",
  "dc.chanRunStores",
  "dc.chanUnbindStore",
  "util.callbackify",
  "util.promisifyDyn",
  "util.debuglog",
  "util.deprecate",
  "util.diff",
  "util.extend",
  "util.inherits",
  "util.inheritsPrototype",
  "util.isArrayDeprecated",
  "util.styleText",
]);

/** The libCalls that enter AsyncLocalStorage stores (RuntimeFeatures
 * asyncContext). */
const ASYNC_CONTEXT_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "als.enterWith",
  "als.exitRun",
  "als.run",
  "dc.chanBindStore",
  "dc.chanRunStores",
  // getTestContext() reads the test runner's entry in the same snapshot.
  "test.context",
  "test.hasContext",
]);

const LEGACY_URL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "url.domainToASCII",
  "url.domainToUnicode",
  "url.legacyClass",
  "url.legacyFormat",
  "url.legacyParse",
  "url.legacyResolve",
]);

const UTIL_CALLABLE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "util.callbackify",
  "util.debuglog",
  "util.deprecate",
  "util.diff",
  "util.extend",
  "util.inherits",
  "util.inheritsPrototype",
  "util.isArrayDeprecated",
]);

/** Entry points that link the regex unit: the regex and glob matchers (fs.glob's walk compiles its patterns with the glob matcher), and readline's terminal unit (scr_readline_tty.c), which measures with the regex unit's stripVTControlCharacters. */
const REGEX_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.nativeRegexIs",
  "fs.callbackGlob",
  "fs.globSync",
  "fs.globTypesSync",
  "fsp.globError",
  "fsp.globStrings",
  "fsp.globTypes",
  "path.matchesGlob",
  "path.win32MatchesGlob",
  // `slice.index` / `slice.input` on a match-slice-typed value reads the
  // match source through scr_regex_result_prop.
  "regex.resultProp",
  "regexp.escape",
  "rl.cursorPos",
  "rl.keypressStdin",
  "rl.keypressStream",
  "stdin.onKeypress",
  "util.stripVTControlCharacters",
]);

/** TextDecoder entry points over the legacy encodings. */
const LEGACY_TEXT_DECODER_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "text.decodeLegacy",
  "text.decodeLegacyOptions",
  "text.decodeStream",
]);

/** Signal-taking readline, stream and timers/promises entry points, which register abort listeners. */
const ABORT_SIGNAL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "events.onceSignal",
  "fileHandle.createReadStreamSignal",
  "fileHandle.createWriteStreamSignal",
  "fs.createReadStreamSignal",
  "fs.createWriteStreamSignal",
  "http.clientSignal",
  "http.requestDyn",
  "http.requestDynCb",
  "https.requestDyn",
  "https.requestDynCb",
  "https.requestFnDyn",
  "https.requestFnDynCb",
  "http.requestUrlDyn",
  "http.requestUrlDynCb",
  "https.requestUrlDyn",
  "https.requestUrlDynCb",
  "rl.createSignal",
  "rl.questionAsyncSignal",
  "sp.finishedOptsSignal",
  "sp.pipelineOptsSignal",
  "stream.addAbortSignal",
  "stream.addAbortSignalFn",
  "stream.finishedOptsSignal",
  "tp.schedulerWaitSignal",
  "tp.setImmediateSignal",
  "tp.setTimeoutSignal",
]);

/** Entry points that link the stream unit (with STREAM_LIB_PREFIXES). */
const STREAM_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "child.stdioStream",
  "stream.chunkDone",
  "stream.objectMode",
  "stream.decodeStrings",
  "stream.optionValues",
  "stream.checkEncodingOption",
  "stream.duplexFromGen",
  "stream.duplexFromDyn",
  "stream.duplexFromPromise",
  "stream.duplexFromAsyncFn",
  "stream.duplexFromGenSignal",
  "stream.duplexFromAsyncFnSignal",
  "fetch.readableFromWeb",
  "stream.duplexifyReadable",
  "stream.duplexifyWritable",
  "stream.duplexifyPair",
  "console.bind",
  "crypto.hashStream",
  "crypto.hashStreamPiped",
  "fileHandle.createReadStream",
  "fileHandle.createReadStreamSignal",
  "fileHandle.createWriteStream",
  "fileHandle.createWriteStreamSignal",
  "fs.createReadStream",
  "fs.createReadStreamSignal",
  "fs.createWriteStream",
  "fs.createWriteStreamSignal",
  "rl.inputFromDyn",
  "rl.outputFromDyn",
  "sp.finished",
  "sp.pipeline",
  "sp.pipelineStages",
  "sp.pipelineStagesOpts",
  "stream.addAbortSignal",
  "stream.addAbortSignalFn",
  "stream.destroy",
  "stream.destroyErr",
  "stream.dynNative",
  "stream.dynNativePipe",
  "stream.errored",
  "stream.is",
  "stream.isDyn",
  "stream.stateDyn",
  "stream.asyncDispose",
  "stream.pipeDyn",
  "stream.prop",
  "stream.stdioWritable",
  "stream.unboxDyn",
  "stream.dynIterableSource",
  "stream.dynSourceValue",
  "stream.dynTransformResult",
  "stream.unboxDynStage",
  "stream.handleStream",
  "stream.handleWritable",
  "stream.unpipeDyn",
  "stream.workerStdio",
]);

/** libCall name prefixes that link the stream unit. */
const STREAM_LIB_PREFIXES: readonly string[] = [
  "duplex.",
  "fs.fsStream",
  "passthrough.",
  "readable.",
  "sc.",
  "sp.finishedOpts",
  "sp.pipelineOpts",
  "stream.finishedOpts",
  "stream.pipelineStages",
  "stream.composeStages",
  "stream.set",
  "transform.",
  "writable.",
  "zlib.stream",
];

/** The Readable operators and Readable.from over a compiled generator or a checked-dynamic iterator (scr_stream_ops.c), which await through the dyn-async unit (with READABLE_DYN_ASYNC_PREFIXES). */
const READABLE_DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "readable.fromAsyncGen",
  "readable.fromAsyncIter",
  "readable.fromDone",
  "readable.fromDyn",
  "readable.fromIter",
  "stream.duplexFromGen",
  "stream.duplexFromDyn",
  "stream.duplexFromPromise",
  "stream.duplexFromAsyncFn",
  "stream.duplexFromGenSignal",
  "stream.duplexFromAsyncFnSignal",
  "stream.unboxDynStage",
]);

/** libCall name prefixes of the Readable entry points that await through the dyn-async unit. */
const READABLE_DYN_ASYNC_PREFIXES: readonly string[] = ["readable.fromGen", "readable.op"];

/** The keyed-collection entry points of scr_dyn_collections.c: the
 * %Set.prototype%/%Map.prototype%/weak-collection prototypes, their member
 * values, the constructors' adder lookup and the ES2025 Set compositions.
 * The unit delegates prototype members through the dyn-invoke unit and
 * interns Symbol.iterator/Symbol.toStringTag through the symbol unit, so
 * every rule that selects this unit also selects those two. */
const DYN_COLLECTION_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.collectionMethod",
  "dyn.collectionPrototype",
  "dyn.collectionGetPrototype",
  "dyn.setCombine",
  "dyn.collectionForEach",
  "dyn.collectionConstruct",
  "dyn.setValues",
]);

/** Entry points that link the dyn-invoke unit. */
const DYN_INVOKE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.arrayProtoCall",
  "dyn.arrayLikeProtoCall",
  "dyn.builtinPrototype",
  "dyn.arrayPrototype",
  "dyn.builtinFunction",
  "dyn.builtinMethod",
  "dyn.builtinMethodValue",
  "dyn.stdlibPrototype",
  "dyn.dataViewPrototype",
  "dyn.defineProperty",
  "dyn.definePropertyShapes",
  "handle.propsDefineProps",
  // The table's member test reads inherited prototype members through
  // scr_dyn_invoke.c's scr_dyn_inherited_read.
  "handle.propsInstall",
  "child.propsDefine",
  "dyn.defineProps",
  "dyn.definePropsShapes",
  "dyn.definePrototypeProps",
  "dyn.functionApply",
  "dyn.globalConstructor",
  "dyn.namespaceDefine",
  "dyn.namespaceNew",
  "dyn.objCreateWithProperties",
  "dyn.objCreateWithPropertiesShapes",
  "dyn.objectTag",
  "stream.dynNative",
  "stream.dynNativePipe",
  "stream.pipeDyn",
  "stream.unpipeDyn",
  ...DYN_COLLECTION_LIB_FNS,
]);

/** Member names whose constant-key dynamic reads answer the inherited Object.prototype member through the dyn-invoke unit. Mirrors expr-dynamic.ts INHERITED_OBJECT_MEMBERS (the IR layer does not import the backend). */
export const INHERITED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
]);

/** Array.prototype's method names. A constant-key dynamic read of one on an array answers the method the array's implicit prototype installs, so the read links the dyn-invoke unit. Mirrors the method table in scr_dyn_invoke.c (runtime-registries.test.ts checks the two agree). */
export const ARRAY_PROTOTYPE_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "at",
  "concat",
  "copyWithin",
  "fill",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "lastIndexOf",
  "pop",
  "push",
  "reverse",
  "shift",
  "unshift",
  "slice",
  "sort",
  "splice",
  "includes",
  "indexOf",
  "join",
  "keys",
  "entries",
  "values",
  "forEach",
  "filter",
  "flat",
  "flatMap",
  "map",
  "every",
  "some",
  "reduce",
  "reduceRight",
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
  "toLocaleString",
  "toString",
]);

/** Entry points that link the child-process unit (with CHILD_PROCESS_LIB_PREFIXES): the fork IPC channel on the process object. */
const CHILD_PROCESS_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "process.connected",
  "process.disconnect",
  "process.forkTarget",
  "process.ipcOpen",
  "process.onDisconnect",
  "process.onMessage",
  "process.send",
  "process.sendCb",
]);

/** libCall name prefixes that link the child-process unit. */
const CHILD_PROCESS_LIB_PREFIXES: readonly string[] = ["child.", "cp.", "spawnRes.", "writer."];

/** The entry points scr_dyn_builtin_class.c defines. The unit calls
 * listeners through the dyn-invoke unit, renders unhandled 'error'
 * payloads through the inspect unit, creates EventEmitter's private
 * symbols through the symbol unit and shares defaultMaxListeners with the
 * emitter unit, so each of them links all five. */
const BUILTIN_CLASS_LIB_FNS: readonly IrLibFn[] = [
  "dyn.builtinClass",
  // the stream classes, through scr_dyn_builtin_stream.c
  "dyn.builtinInstanceOf",
  "dyn.builtinStreamClass",
  "dyn.functionInstanceOf",
];

/** Entry points that link the symbol unit, besides the sym. and disposable. families. */
const SYMBOL_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  // Web streams answer async iteration through Symbol.asyncIterator.
  "webstream.class",
  "webstream.from",
  "webstream.instanceOf",
  "webstream.install",
  // EventEmitter's kShapeMode and kCapture properties
  ...BUILTIN_CLASS_LIB_FNS,
  "dyn.usingDispose",
  "dyn.usingMethod",
  "util.isDeepStrictEqual",
  // The Buffer function value's Symbol(kIsEncodingSymbol) member
  "buffer.constructor",
  "buffer.staticValue",
  "buffer.prototypeMember",
  ...DYN_COLLECTION_LIB_FNS,
  "buffer.prototypeObject",
  // A symbol event name's registry key (scr_str_symbol_key lives in the
  // string unit, but the emitter registry holds the symbol itself).
  "emitter.symName",
  // The array-like unit reads a receiver's @@isConcatSpreadable through
  // scr_sym_well_known before it spreads that receiver's elements.
  "dyn.arrayLikeProtoCall",
]);

/** Entry points that link the querystring unit. */
const QS_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "qs.parse",
  "qs.parseCustom",
  "qs.stringify",
  "qs.stringifyCustom",
  "qs.separator",
  "qs.unescape",
  "qs.unescapeBuffer",
]);

/** Entry points that link the parseArgs unit. */
const PARSE_ARGS_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "util.isDeepStrictEqual",
  "util.parseArgs",
  "util.styleText",
]);

/** String methods whose Unicode tables live in the regex unit's libunicode. */
const CASE_MAPPING_STR_METHODS: ReadonlySet<string> = new Set([
  "normalize",
  "toLowerCase",
  "toUpperCase",
]);

/** Array methods that link the copying unit. */
const COPYING_ARR_METHODS: ReadonlySet<string> = new Set([
  "toReversed",
  "toSpliced",
  "with",
  "withUndefined",
]);

/** Typed-array methods that link the copying unit. */
const COPYING_BYTES_METHODS: ReadonlySet<string> = new Set([
  "join",
  "toArray",
  "toReversed",
  "with",
]);

/** Inspect types and expressions together in one traversal. This is a fresh
 * snapshot: callers may mutate an IR module between compilation passes. */
/** The checked-dynamic undefined value (dynUndefinedExpr). */
export function isDynUndefined(e: IrExpr): boolean {
  return e.kind === "dynFrom" && e.value.kind === "unitLit" && e.value.unit === "undefined";
}

/** With `nodes` (the module's node index), the scan reads the recorded
 * expressions and types instead of walking the module. */
export function moduleRuntimeFeatures(mod: IrModule, nodes?: IrNodeIndex): RuntimeFeatures {
  return scanRuntimeFeatures(mod, undefined, nodes);
}

/** The module's record shapes, unions and class layouts by id. */
interface TypeTables {
  records: Map<string, IrRecordShape>;
  unions: Map<string, IrUnionDef>;
  classes: Map<string, IrClassDef>;
  /** mentionsDgramSocket's carriers, computed on first use. */
  dgramCarriers?: TypeCarriers;
  /** mentionsChild's carriers. */
  childCarriers?: TypeCarriers;
  /** mentionsTextCodec's and mentionsTextDecoder's carriers. */
  textCodecCarriers?: TypeCarriers;
  textDecoderCarriers?: TypeCarriers;
  /** mentionsU8Bytes's carriers. */
  u8BytesCarriers?: TypeCarriers;
}

/** Whether `t`, the record of a `Promise.withResolvers()`, holds a promise
 * of a checked-dynamic value. */
function resolversOfDyn(t: IrType, tables: TypeTables): boolean {
  if (t.kind !== "record") return false;
  const promise = tables.records.get(t.shapeId)?.fields.find((f) => f.name === "promise")?.type;
  return promise?.kind === "promise" && promise.inner.kind === "dyn";
}

/** Whether boxing a value of type `t` as dyn boxes a promise, which goes
 * through scr_async_dyn.c: a promise, a function whose result type holds
 * one, or a record, array, tuple, union, Map or Set that holds either. */
function boxesPromise(t: IrType, tables: TypeTables, seen: Set<string>): boolean {
  switch (t.kind) {
    case "promise":
      return true;
    case "func":
      // A boxed function converts its result to dyn, which boxes any promise
      // the result type holds.
      return boxesPromise(t.ret, tables, seen);
    case "array":
    case "set":
      return boxesPromise(t.elem, tables, seen);
    case "map":
      return boxesPromise(t.key, tables, seen) || boxesPromise(t.value, tables, seen);
    case "record": {
      if (seen.has(t.shapeId)) return false;
      seen.add(t.shapeId);
      const shape = tables.records.get(t.shapeId);
      return shape?.fields.some((f) => boxesPromise(f.type, tables, seen)) ?? false;
    }
    case "union": {
      if (seen.has(t.unionId)) return false;
      seen.add(t.unionId);
      const def = tables.unions.get(t.unionId);
      return def?.arms.some((a) => boxesPromise(a, tables, seen)) ?? false;
    }
    case "object": {
      // A boxed class instance exposes its fields as dyn values (Object.keys,
      // spread, inspection), boxing a promise any field holds. It
      // materializes inherited fields too, and the instance can be any
      // subclass.
      const key = `class:${t.className}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const related = (def: IrClassDef): boolean => {
        for (
          let c: IrClassDef | undefined = def;
          c;
          c = c.base ? tables.classes.get(c.base) : undefined
        )
          if (c.name === t.className) return true;
        return false;
      };
      for (const def of tables.classes.values()) {
        if (!related(def)) continue;
        for (
          let c: IrClassDef | undefined = def;
          c;
          c = c.base ? tables.classes.get(c.base) : undefined
        )
          if (c.fields.some((f) => boxesPromise(f.type, tables, seen))) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** The record shapes, unions and classes whose values carry a leaf type
 * (directly or through other members), computed once per module and leaf. */
interface TypeCarriers {
  records: Set<string>;
  unions: Set<string>;
  anyClass: boolean;
}

/** The leaf a carrier set tracks: a dgram socket, a codec record. */
type CarrierLeaf = (t: IrType, tables: TypeTables) => boolean;

/** Whether `t` carries a leaf, given the carrier sets so far: structural
 * through functions (parameters and result), promises and collections;
 * named records, unions and class instances by the sets. */
function carriesLeaf(
  t: IrType,
  carriers: TypeCarriers,
  leaf: CarrierLeaf,
  tables: TypeTables,
): boolean {
  if (leaf(t, tables)) return true;
  switch (t.kind) {
    case "func":
      return (
        t.params.some((p) => carriesLeaf(p, carriers, leaf, tables)) ||
        carriesLeaf(t.ret, carriers, leaf, tables)
      );
    case "promise":
      return carriesLeaf(t.inner, carriers, leaf, tables);
    case "array":
    case "set":
      return carriesLeaf(t.elem, carriers, leaf, tables);
    case "map":
      return (
        carriesLeaf(t.key, carriers, leaf, tables) || carriesLeaf(t.value, carriers, leaf, tables)
      );
    case "record":
      return carriers.records.has(t.shapeId);
    case "union":
      return carriers.unions.has(t.unionId);
    case "object":
      // Any class may be the instance's runtime class or one of its bases.
      return carriers.anyClass;
    default:
      return false;
  }
}

/** The module's carriers of `leaf`: a fixpoint over its records, unions and
 * class fields. */
function leafCarriers(tables: TypeTables, leaf: CarrierLeaf): TypeCarriers {
  const carriers: TypeCarriers = { records: new Set(), unions: new Set(), anyClass: false };
  const carries = (t: IrType): boolean => carriesLeaf(t, carriers, leaf, tables);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, shape] of tables.records)
      if (
        !carriers.records.has(id) &&
        (leaf({ kind: "record", shapeId: id }, tables) || shape.fields.some((f) => carries(f.type)))
      ) {
        carriers.records.add(id);
        changed = true;
      }
    for (const [id, def] of tables.unions)
      if (!carriers.unions.has(id) && def.arms.some(carries)) {
        carriers.unions.add(id);
        changed = true;
      }
    if (
      !carriers.anyClass &&
      [...tables.classes.values()].some((c) => c.fields.some((f) => carries(f.type)))
    ) {
      carriers.anyClass = true;
      changed = true;
    }
  }
  return carriers;
}

const dgramLeaf: CarrierLeaf = (t) => t.kind === "dgramSocket";

/** Whether converting a value of type `t` to or from dyn converts a dgram
 * socket, which goes through scr_dgram_dyn.c: the socket itself, or a
 * function, collection, record, union, promise or class instance that
 * carries one (boxed functions convert their parameters too). */
function mentionsDgramSocket(t: IrType, tables: TypeTables): boolean {
  tables.dgramCarriers ??= leafCarriers(tables, dgramLeaf);
  return carriesLeaf(t, tables.dgramCarriers, dgramLeaf, tables);
}

const childLeaf: CarrierLeaf = (t) => t.kind === "child";

/** Whether converting a value of type `t` to dyn boxes a ChildProcess: the
 * child itself, or a function, collection, record, union, promise or class
 * instance that carries one (the same carrier walk as dgram sockets). */
function mentionsChild(t: IrType, tables: TypeTables): boolean {
  tables.childCarriers ??= leafCarriers(tables, childLeaf);
  return carriesLeaf(t, tables.childCarriers, childLeaf, tables);
}

const textCodecLeaf: CarrierLeaf = (t, tables) => {
  if (t.kind !== "record") return false;
  const shape = tables.records.get(t.shapeId);
  return shape !== undefined && recordHandleCodecClass(shape) !== null;
};

const textDecoderLeaf: CarrierLeaf = (t, tables) => {
  if (t.kind !== "record") return false;
  const shape = tables.records.get(t.shapeId);
  return shape !== undefined && recordTextCodecClass(shape) === "TextDecoder";
};

/** Whether converting a value of type `t` to or from dyn converts a
 * TextEncoder, TextDecoder or StringDecoder record, which boxes it as a handle of
 * scr_text_codec_dyn.c (the same carrier walk as dgram sockets). */
function mentionsTextCodec(t: IrType, tables: TypeTables): boolean {
  tables.textCodecCarriers ??= leafCarriers(tables, textCodecLeaf);
  return carriesLeaf(t, tables.textCodecCarriers, textCodecLeaf, tables);
}

/** The TextDecoder half: its boxed decode runs scr_text_decode_stream,
 * which reaches the legacy decoders. */
function mentionsTextDecoder(t: IrType, tables: TypeTables): boolean {
  tables.textDecoderCarriers ??= leafCarriers(tables, textDecoderLeaf);
  return carriesLeaf(t, tables.textDecoderCarriers, textDecoderLeaf, tables);
}

/** The libCall fns served by the OPTIONAL events unit (scr_events.c):
 * process signal/exit listeners and the piped-stdin surface. */
const PROCESS_EVENT_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "process.offExit",
  "process.offSignal",
  "process.onExit",
  "process.onSignal",
  "process.prependExit",
  "process.prependSignal",
  "process.stdio",
  "process.stdinIsRaw",
  "process.stdioSlot",
  "process.stdioWriteDyn",
  "process.stdioWriteStr",
  "stdin.nextChunk",
  "stdin.onData",
  "stdin.onEnd",
  "stdin.onError",
  "stdin.onReadable",
  "stdin.pause",
  "stdin.resume",
  "stdin.isPaused",
  "stdin.readableLength",
  "stdin.read",
  // node:readline rides the stdin unit (scr_readline.c links beside
  // scr_events.c under the same gate).
  "rl.checkCompleter",
  "rl.checkOptions",
  "rl.close",
  "rl.create",
  "rl.createSignal",
  "rl.cursor",
  "rl.cursorPos",
  "rl.getPrompt",
  "rl.history",
  "rl.isPromises",
  "rl.isTerminal",
  "rl.iterNext",
  "rl.iterOpen",
  "rl.iterReturn",
  "rl.keypressStdin",
  "rl.keypressStream",
  "rl.line",
  "rl.moves",
  "rl.numProp",
  "rl.on",
  "rl.pause",
  "rl.prompt",
  "rl.promptWith",
  "rl.question",
  "rl.questionAsync",
  "rl.questionAsyncDyn",
  "rl.questionAsyncSignal",
  "rl.questionAsyncSignalDyn",
  "rl.questionDyn",
  "rl.resume",
  "rl.seq",
  "rl.setHistory",
  "rl.setOptions",
  "rl.setPrompt",
  "rl.setPromptDyn",
  "rl.terminal",
  "rl.uiClearLine",
  "rl.uiClearScreenDown",
  "rl.uiCommit",
  "rl.uiCursorTo",
  "rl.uiMoveCursor",
  "rl.uiOpen",
  "rl.uiOpenStream",
  "rl.uiRollback",
  "rl.write",
  "rl.writeKey",
  "stdin.onKeypress",
]);

/** The legacy http2.* libCalls implemented by scr_http.c/scr_tls.c (the
 * allowHTTP1 compatibility slice) — they must NOT pull scr_http2.c, so
 * divergence-57 binaries keep their exact link line. */
const HTTP2_LEGACY_FNS: ReadonlySet<IrLibFn> = new Set([
  "http2.streamNoop",
  "http2.streamUndefCall",
]);

/** The libCall nodes the rules below test. */
type LibCallNode = IrExpr & { kind: "libCall" };

/** A condition over several nodes of the module (a WebCrypto call and an
 * algorithm name): the scan's one walk shows it every expression, and the
 * feature is set when `result` answers true after the walk. */
interface RuleScan {
  expr(node: IrExpr): void;
  result(): boolean;
}

/** What makes a program need one optional runtime unit. The feature is set
 * when any condition holds: `initial` from the module's declarations, a
 * libCall named in `fns` or starting with one of `prefixes`, a libCall
 * `libCall` accepts, another expression node `expr` accepts, a type slot of
 * one of the `types` kinds, or a `scan` over the whole module. A libCall or
 * type that needs several units appears in each unit's rule. */
interface RuntimeFeatureRule {
  initial?: (mod: IrModule) => boolean;
  scan?: (mod: IrModule) => RuleScan;
  fns?: readonly IrLibFn[];
  prefixes?: readonly string[];
  libCall?: (node: LibCallNode) => boolean;
  expr?: (node: IrExpr, tables: () => TypeTables) => boolean;
  types?: readonly IrType["kind"][];
}

/** Gives every rule in the table one type. */
const rule = (r: RuntimeFeatureRule): RuntimeFeatureRule => r;

/** The live capsule an adoption boxes a value of type `type` as, for the
 * rules that read what a module boxes: the backend builds it where it
 * emits the adoption (a `dynCheck` with `shared`), so no `dynFrom` in the
 * module stands for it. */
function adoptionCapsule(type: IrType, loc: IrExpr["loc"]): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "varRef", localId: "%adopted", type, loc },
    liveRef: true,
    type: { kind: "dyn" },
    loc,
  };
}

/** Whether the module holds a runtimeFence that stands for a deferred
 * diagnostic: the statement the backend throws through the reporter. A
 * library's fences keep the plain throw (emit-statements.ts), so a library
 * never asks for the reporter. */
function moduleHasDeferredFence(mod: IrModule): boolean {
  if (mod.lib !== undefined) return false;
  let found = false;
  everyModuleNode(mod, {
    expr: () => !found,
    stmt: (node) => {
      if (
        node.kind === "runtimeFence" &&
        isDeferredDiagnosticFence(node.code, node.message, node.loc.file)
      )
        found = true;
      return !found;
    },
    type: () => !found,
  });
  return found;
}

/* The node:url and WHATWG URL entry points: every URL value comes from
 * one, and parsing one can reach the UTS #46 host processing. */
const URL_PREFIXES: readonly string[] = ["url."];

/* The HTTP, HTTPS, HTTP/2 and TLS surfaces, which link the net unit. */
const NET_PREFIXES: readonly string[] = ["net.", "http.", "tls.", "https.", "http2."];

/** The scr_dh.c entry points (the dh unit). */
export const DH_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "crypto.dhNew",
  "crypto.dhGroupNew",
  "crypto.checkPrimeSync",
  "crypto.checkPrimeCb",
  "crypto.generatePrimeSync",
  "crypto.generatePrimeCb",
]);

/** The scr_pki.c entry points (the pki unit). */
export const PKI_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "crypto.createPrivateKey",
  "crypto.createPublicKey",
  "crypto.createSign",
  "crypto.createVerify",
  "crypto.generateKeyPairCb",
  "crypto.generateKeyPairSync",
  "crypto.signOneshot",
  "crypto.verifyOneshot",
  "crypto.x509PublicKey",
  "crypto.x509Verify",
  "crypto.x509CheckPrivateKey",
  "crypto.diffieHellman",
]);

/** The WebCrypto algorithms scr_webcrypto_pki.c implements over the pki
 * unit (lowercased). */
const WEBCRYPTO_ASYMMETRIC_NAMES: ReadonlySet<string> = new Set([
  "ecdsa",
  "ed25519",
  "rsa-pss",
  "rsassa-pkcs1-v1_5",
]);

/** Whether a string literal in the module names Ed25519, without regard
 * to case ("ed25519" for node:crypto, "Ed25519" for WebCrypto): the
 * Ed25519 unit links then, alongside the pki unit. */
function ed25519NameScan(): RuleScan {
  let named = false;
  return {
    expr: (node) => {
      if (!named && node.kind === "strLit" && node.value.toLowerCase() === "ed25519") named = true;
    },
    result: () => named,
  };
}

/** tty.WriteStream's color methods, which the process stream object has
 * only in the build a program that names them selects. */
const TERMINAL_COLOR_METHODS: ReadonlySet<string> = new Set(["getColorDepth", "hasColors"]);

/** Whether the module holds a process stream as a value (a stream-typed
 * expression, or the stream object itself) and names one of the terminal
 * color methods: as the method of a dynamic call, as a string (a member
 * read by name, a computed key, a call relayed by name), or as the key of an
 * `in` test. A key computed at run time is not seen: the stream object then
 * answers what it answers for every name it does not know. */
function terminalColorMethodScan(): RuleScan {
  let stream = false;
  let named = false;
  return {
    expr: (node) => {
      if (!stream)
        stream =
          node.type.kind === "procStream" ||
          (node.kind === "libCall" &&
            (node.fn === "process.stdio" || node.fn === "process.stdioSlot"));
      if (!named)
        named =
          (node.kind === "strLit" && TERMINAL_COLOR_METHODS.has(node.value)) ||
          (node.kind === "dynInvoke" && TERMINAL_COLOR_METHODS.has(node.method)) ||
          (node.kind === "dynHasKey" && TERMINAL_COLOR_METHODS.has(node.key));
    },
    result: () => stream && named,
  };
}

/** moduleUsesWebCryptoAsymmetric's condition as a runtime-feature scan. */
function webCryptoAsymmetricScan(): RuleScan {
  let webcrypto = false;
  let named = false;
  return {
    expr: (node) => {
      if (node.kind === "libCall" && node.fn.startsWith("webcrypto.")) webcrypto = true;
      else if (
        !named &&
        node.kind === "strLit" &&
        WEBCRYPTO_ASYMMETRIC_NAMES.has(node.value.toLowerCase())
      )
        named = true;
    },
    result: () => webcrypto && named,
  };
}

/** The Buffer.prototype method names a checked-dynamic read can answer from
 * scr_bytes_dyn.c: the ones calls route there, and the members Buffer
 * defines over %TypedArray%.prototype's. */
const BUFFER_PROTOTYPE_METHOD_NAMES: ReadonlySet<string> = new Set([
  ...DYN_BUFFER_METHODS.keys(),
  "subarray",
  "slice",
  "toLocaleString",
]);

const u8BytesLeaf: CarrierLeaf = (t) => t.kind === "bytes" && t.elem === "u8";

/** Whether converting a value of type `t` to dyn can box a Buffer: a
 * Uint8Array or Buffer, or a function, collection, record, union, promise
 * or class instance that carries one. */
function mentionsU8Bytes(t: IrType, tables: TypeTables): boolean {
  tables.u8BytesCarriers ??= leafCarriers(tables, u8BytesLeaf);
  return carriesLeaf(t, tables.u8BytesCarriers, u8BytesLeaf, tables);
}

/** A checked-dynamic read with a key computed at run time, or one naming a
 * Buffer.prototype method, in a module that makes Buffer values and boxes a
 * value that can hold one: `buf[name]` and `buf.indexOf` read as values
 * name Buffer.prototype methods, which scr_bytes_dyn.c answers. A Buffer
 * value also comes from a typed file read, which answers a branded Buffer
 * with no `buffer.*` call, so those reads count as making one. */
function computedBufferMemberScan(mod: IrModule): RuleScan {
  let tables: TypeTables | undefined;
  const typeTables = (): TypeTables =>
    (tables ??= {
      records: new Map((mod.records ?? []).map((r) => [r.id, r])),
      unions: new Map((mod.unions ?? []).map((u) => [u.id, u])),
      classes: new Map((mod.classes ?? []).map((c) => [c.name, c])),
    });
  let computed = false;
  let buffer = false;
  let boxed = false;
  return {
    expr: (node) => {
      if (
        node.kind === "dynKeyGet" &&
        (node.key.kind !== "strLit" || BUFFER_PROTOTYPE_METHOD_NAMES.has(node.key.value))
      )
        computed = true;
      else if (node.kind === "libCall" && node.fn.startsWith("buffer.")) buffer = true;
      else if (node.kind === "libCall" && FS_READ_BYTES_FNS.has(node.fn)) buffer = true;
      else if (!boxed && node.kind === "dynFrom" && mentionsU8Bytes(node.value.type, typeTables()))
        boxed = true;
    },
    result: () => computed && buffer && boxed,
  };
}

/** Whether the module calls WebCrypto and a string literal in it names one
 * of the asymmetric algorithms (matched without regard to case, as
 * normalizeAlgorithm matches names): scr_webcrypto_pki.c and the pki unit
 * link then. */
export function moduleUsesWebCryptoAsymmetric(mod: IrModule): boolean {
  let webcrypto = false;
  let named = false;
  everyModuleNode(mod, {
    expr: (node) => {
      if (node.kind === "libCall" && node.fn.startsWith("webcrypto.")) webcrypto = true;
      if (node.kind === "strLit" && WEBCRYPTO_ASYMMETRIC_NAMES.has(node.value.toLowerCase()))
        named = true;
      return !(webcrypto && named);
    },
    stmt: () => !(webcrypto && named),
    type: () => true,
  });
  return webcrypto && named;
}

/** Whether a property name spells a canonical array index `String(i)` for
 * an integer i below 2^32 - 1: digits only, and no leading zero unless the
 * whole name is "0". */
function isIndexString(name: string): boolean {
  if (name.length === 0 || name.length > 10) return false;
  if (name.length > 1 && name[0] === "0") return false;
  let index = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    index = index * 10 + (c - 48);
  }
  return index < 4294967295;
}

/** The index past which an array write cannot materialize its holes: the
 * dense prefix scr_json.c is willing to fill (`+ 1000000`). */
const SPARSE_INDEX_LIMIT = 1_000_000;

/** The literal a value carries: a literal node, or the checked-dynamic
 * boxing of one (`a[987654321] = v` boxes its key). */
type LiteralNode = Extract<IrExpr, { kind: "numLit" } | { kind: "strLit" }>;

function literalOf(expr: IrExpr): LiteralNode | undefined {
  const raw = expr.kind === "dynFrom" ? expr.value : expr;
  return raw.kind === "numLit" || raw.kind === "strLit" ? raw : undefined;
}

/** The canonical index a value spells: a number that is one, or a string
 * that names one. */
function literalIndex(expr: IrExpr): number | undefined {
  const lit = literalOf(expr);
  if (lit === undefined) return undefined;
  if (lit.kind === "numLit")
    return Number.isInteger(lit.value) && lit.value >= 0 && lit.value < 4294967295
      ? lit.value
      : undefined;
  return isIndexString(lit.value) ? Number(lit.value) : undefined;
}

/** The receiver, key and value one dynamic member write takes, or three
 * undefined for any other node. A write is a `dyn.keySet`/`dyn.keySetComputed`
 * call or a call into a class-dispatch stub that carries the stored value
 * (class-dynamic-dispatch.ts `%dyn.class.computed.<n>` and
 * `%dyn.class.named.<n>`). */
function writeArgs(node: IrExpr): [IrExpr | undefined, IrExpr | undefined, IrExpr | undefined] {
  const none: [undefined, undefined, undefined] = [undefined, undefined, undefined];
  if (node.kind === "libCall") {
    if (node.fn !== "dyn.keySet" && node.fn !== "dyn.keySetComputed") return none;
    return [node.args[0], node.args[1], node.args[2]];
  }
  if (
    node.kind === "call" &&
    (node.callee.startsWith("%dyn.class.computed.") ||
      node.callee.startsWith("%dyn.class.named.")) &&
    node.args.length >= 3
  )
    return [node.args[0], node.args[1], node.args[2]];
  return none;
}

/** Whether the module writes an array element at an index the source
 * spells past SPARSE_INDEX_LIMIT, or sets `length` to a spelled value past
 * it: the sparse writes a static fact can prove (see the sparseArrays
 * rule). A keyed write evaluates its key into a hidden local first
 * (lower-exprs.ts lowerDynMemberAssignment), so the write reads the literal
 * the source spells back through that local's one definition. */
function moduleWritesSparseIndex(mod: IrModule): boolean {
  const literals = new Map<string, LiteralNode>();
  const definitions = new Map<string, IrExpr>();
  /** The assigns a global takes. A module-level `const view = typed`
   * initializes its global with an assign rather than a varDecl; a local
   * assigned more than once could hold anything by the time of the write. */
  const assigns = new Map<string, IrExpr[]>();
  everyModuleNode(mod, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind === "assign") {
        const taken = assigns.get(node.localId);
        if (taken === undefined) assigns.set(node.localId, [node.value]);
        else taken.push(node.value);
        return true;
      }
      if (node.kind !== "varDecl" || node.init === null) return true;
      definitions.set(node.localId, node.init);
      const literal = literalOf(node.init);
      if (literal !== undefined) literals.set(node.localId, literal);
      return true;
    },
    type: () => true,
  });
  const reassigned = new Set<string>();
  for (const [localId, values] of assigns) {
    if (values.length === 1) definitions.set(localId, values[0]!);
    else reassigned.add(localId);
  }
  /** The literal behind a hidden local, or the node itself when the
   * lowering spelled it directly. */
  const resolve = (expr: IrExpr): LiteralNode | undefined =>
    expr.kind === "varRef" ? literals.get(expr.localId) : literalOf(expr);
  /** Whether the value a local holds, followed through the locals and
   * globals it is copied from, is a live view of a native array (`const
   * view: any = typed`). Such an array already keeps the elements past its
   * dense prefix in its own out-of-line storage (the ScrArr ext), so a far
   * write through the view needs no part of the checked-dynamic array's
   * sparse support: the typed path answers it, in the default build too. */
  const holdsNativeView = (start: IrExpr): boolean => {
    let expr = start;
    for (let hop = 0; hop < 4; hop++) {
      if (expr.kind === "dynFrom") {
        if (expr.value.type.kind === "array") return true;
        expr = expr.value;
        continue;
      }
      if (expr.kind !== "varRef" || reassigned.has(expr.localId)) return false;
      const next = definitions.get(expr.localId);
      if (next === undefined) return false;
      expr = next;
    }
    return false;
  };
  const writesNativeView = (receiver: IrExpr): boolean => {
    const init = receiver.kind === "varRef" ? definitions.get(receiver.localId) : undefined;
    return holdsNativeView(init ?? receiver);
  };
  let sparse = false;
  everyModuleNode(mod, {
    expr: (node) => {
      if (sparse) return false;
      const [receiver, rawKey, rawValue] = writeArgs(node);
      if (receiver === undefined || rawKey === undefined || rawValue === undefined) return true;
      if (writesNativeView(receiver)) return true;
      const key = resolve(rawKey);
      const index = key === undefined ? undefined : literalIndex(key);
      if (index !== undefined && index > SPARSE_INDEX_LIMIT) sparse = true;
      else if (key?.kind === "strLit" && key.value === "length") {
        const value = resolve(rawValue);
        const length = value === undefined ? undefined : literalIndex(value);
        if (length !== undefined && length > SPARSE_INDEX_LIMIT) sparse = true;
      }
      return !sparse;
    },
    stmt: () => !sparse,
    type: () => true,
  });
  return sparse;
}

/** The typed reads that answer a ScrBytes: Node answers a Buffer, and
 * scr_lib.c's read entries brand it, so a typed read makes a Buffer value.
 * A spawnSync capture (spawnRes.stdoutBytes/stderrBytes) arrives from
 * scr_child_capture.c, whose accessors stamp the same brand. */
const FS_READ_BYTES_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "fs.readFileSyncBuf",
  "fs.readFileSyncBytes",
  "fs.readFdSyncBytes",
  "fsp.readFileBytes",
  "fileHandle.readFileBytes",
  "spawnRes.stdoutBytes",
  "spawnRes.stderrBytes",
]);

/** The entries that need the JavaScript object model build (t262-da §J):
 * the runtime code a JavaScript source reaches for builtin intrinsics,
 * array attributes, BigInt views, handle property tables and buffer views
 * that no typed program can observe. Empty until the first slice lands
 * (A1 adds dyn.intrinsic); the slices share one SCR_JS_OBJECT_MODEL build
 * of every unit they touch instead of one build column per feature. */
export const JS_OBJECT_MODEL_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  // Resizable ArrayBuffers and growable SharedArrayBuffers (t262-dc C2), and
  // the arming call that turns on the buffer views registry.
  "arrayBuffer.newResizable",
  "sharedArrayBuffer.newGrowable",
  "arrayBuffer.armMutable",
]);

/** The member name Object.prototype answers as an accessor (protoAccessor):
 * a dynamic read (`dynKeyGet`) or a dynamic key write names it. */
export function isProtoKeyLiteral(node: IrExpr): boolean {
  return node.kind === "strLit" && node.value === "__proto__";
}

/** The dynamic key operations whose member-name argument reaches the write
 * path (dyn.keySet, and the bag entries a JavaScript source's object
 * literals use). */
const PROTO_KEY_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "dyn.bagGet",
  "dyn.bagSet",
  "dyn.keySet",
]);

/** The JavaScript object model build's program facts (t262-da §J): every
 * runtime feature that shares the one SCR_JS_OBJECT_MODEL build ORs in here
 * (BigInt views today, array attributes and handle property tables next), so
 * pack selection and the source build (RUNTIME_DEFINES, the library's
 * cflags) agree on when the build is on. */
export function jsObjectModelFact(features: {
  jsObjectModel?: boolean;
  bigintBytes?: boolean;
  handleProps?: boolean;
  mutableBuffers?: boolean;
  protoAccessor?: boolean;
  sparseArrays?: boolean;
}): boolean {
  return (
    features.jsObjectModel === true ||
    features.bigintBytes === true ||
    features.handleProps === true ||
    features.mutableBuffers === true ||
    features.protoAccessor === true ||
    features.sparseArrays === true
  );
}

/** The Function.prototype and Object.prototype members a function's own
 * data property can shadow, the names the runtime's function-property write
 * path creates and its call/apply/bind and valueOf dispatch read first
 * (`fn.call = f`). Mirrors the reserved list in
 * packages/runtime/src/scr_json.c. */
const FN_OWN_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "apply",
  "bind",
  "call",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "valueOf",
]);

/** The keyed operations that create or remove an own property; the member
 * name is the second argument. */
const FN_MEMBER_KEY_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "dyn.defineProperty",
  "dyn.definePropertyShapes",
  "dyn.keyDelete",
  "dyn.keyDeleteComputed",
  "dyn.keySet",
  "dyn.keySetComputed",
]);

/** The lifted helper every `Object.defineProperty` on a dynamic target
 * becomes (class-dynamic-dispatch.ts). Its body forwards to
 * dyn.defineProperty through parameters, so the key a call site spells is
 * visible only at the call into it, not at the library call inside. */
const FN_OWN_DEFINE_HELPER = "%dyn.class.defineProperty";

/** The target and key of a node that creates or removes an own property:
 * the keyed library calls, or a call into the lifted define helper. Whether
 * the node is a definition (whose receiver must be able to be a function) or
 * a keyed write or delete (which names the shadow itself once its key
 * spells it). */
function ownMemberOp(
  node: IrExpr,
): { target: IrExpr | undefined; key: IrExpr | undefined; definition: boolean } | undefined {
  if (node.kind === "libCall") {
    if (!FN_MEMBER_KEY_LIB_FNS.has(node.fn)) return undefined;
    return {
      target: node.args[0],
      key: node.args[1],
      definition: node.fn.startsWith("dyn.define"),
    };
  }
  if (node.kind === "call" && node.callee === FN_OWN_DEFINE_HELPER)
    return { target: node.args[0], key: node.args[1], definition: true };
  return undefined;
}

/** The name a key expression spells, followed through the hidden local a
 * keyed operation evaluates it into (lower-exprs.ts lowerDynMemberAssignment
 * and the definition paths store the member name in a local first) and the
 * dynamic box a string key takes. Undefined when the key is not a literal
 * the source spells. */
function spelledMemberName(expr: IrExpr, definitions: Map<string, IrExpr>): string | undefined {
  let node: IrExpr | undefined = expr;
  for (let step = 0; node !== undefined && step < 8; step++) {
    if (node.kind === "strLit") return node.value;
    if (node.kind === "dynFrom") node = node.value;
    else if (node.kind === "varRef") node = definitions.get(node.localId);
    else return undefined;
  }
  return undefined;
}

/** Whether a value of this type can reach the write path as a function: the
 * typed callables (`func`, and a class value, whose runtime node is its
 * constructor function) and the unchecked dynamic tiers, where the program
 * stores whatever it likes. Every other type boxes to an object or a
 * primitive, whose property table is the ordinary one. */
function typeHoldsCallable(type: IrType): boolean {
  return (
    type.kind === "func" || type.kind === "classval" || type.kind === "dyn" || type.kind === "jsval"
  );
}

/** Whether the receiver of a definition can be a function at run time. A
 * TYPED operand names its own kind (callable-properties.ts callableBox keeps
 * the boxed value's type); a checked-dynamic operand names nothing, so an
 * any-typed function among the values it holds reaches the write as one and
 * the definition must select the build that admits the own property. */
function mayHoldCallable(expr: IrExpr | undefined): boolean {
  if (expr === undefined) return false;
  return typeHoldsCallable(expr.kind === "dynFrom" ? expr.value.type : expr.type);
}

/** The inherited members only the SCR_FN_MEMBER_PROPS build of scr_json.c
 * has a VALUE for (scr_fn_inherited_value), which a read that spells them
 * selects: the default build answers their member calls through the native
 * lowering and reads the member itself as undefined, where a function
 * inherits it. `apply` has a value in every build. `toString` has one only
 * in that build too, but a spelled read of it cannot select the build: the
 * string conversion of a dynamic value (`String(value)`) lowers to that
 * very read, in programs that never name the member. */
const FN_INHERITED_VALUE_NAMES: ReadonlySet<string> = new Set(["bind", "call"]);

/** Members whose DELETE selects the build: the default build stores an own
 * `toString` on a function like any expando, and a delete then reveals the
 * inherited member, which only that build has a value for. */
const FN_REVEALED_BY_DELETE: ReadonlySet<string> = new Set(["toString"]);

/** The literal a read's key spells: bare for a dotted read, boxed for a
 * literal bracket (`fn["call"]` evaluates its key into the dynamic tier). */
function spelledReadKey(key: IrExpr): string | undefined {
  if (key.kind === "strLit") return key.value;
  return key.kind === "dynFrom" && key.value.kind === "strLit" ? key.value.value : undefined;
}

/** Whether the function reads one of those members as a value through the
 * checked-dynamic tier (`typeof fn.call`, `const c = fn.bind`, `fn["call"]`
 * on a value that may be a function): a keyed read whose key the source
 * spells. A key computed at run time cannot be proven one of the names, so
 * it keeps the build the rest of the program selects. */
function functionReadsInheritedMember(fn: IrFunction): boolean {
  let found = false;
  everyStmtList(fn.body, {
    expr: (node) => {
      if (!found && node.kind === "dynKeyGet") {
        const name = spelledReadKey(node.key);
        if (name !== undefined && FN_INHERITED_VALUE_NAMES.has(name)) found = true;
      }
      return !found;
    },
    stmt: () => !found,
  });
  return found;
}

/** Whether the module creates or removes an own property on a function:
 * `fn.call = f`, `Object.defineProperty(fn, "bind", …)`, `delete fn.apply`,
 * which JS answers with an own data property that shadows the inherited
 * member, or reads as a value an inherited member only that build
 * materializes (functionReadsInheritedMember), or deletes a `toString`
 * (FN_REVEALED_BY_DELETE). Such a program links the
 * SCR_FN_MEMBER_PROPS builds of scr_json.c (the member write/define/delete,
 * own-valueOf and inherited-value paths) and scr_dyn_invoke.c
 * (the own call/apply/bind dispatch), selected by the fnMemberProps rule;
 * every other program keeps those units' default objects, byte for byte. A
 * keyed write whose key spells one of the names counts even on a
 * checked-dynamic receiver, because the closure's table is the only object
 * kind those names shadow. A definition counts on a receiver that can be a
 * function: a typed callable, a class value, or a checked-dynamic value,
 * which may hold an any-typed function. Only a boxed non-callable (a record,
 * bytes, a handle) proves the definition never reaches the function path, so
 * a definition on one of those selects the default objects. */
function moduleShadowsFunctionMember(mod: IrModule): boolean {
  return mod.functions.some((fn) => functionShadowsMember(fn) || functionReadsInheritedMember(fn));
}

/** One function's nodes: its hidden key locals are function-scope, and the
 * same `%setKey.0` id names a different value in every function, so the
 * definitions map must not cross a function boundary. */
function functionShadowsMember(fn: IrFunction): boolean {
  const definitions = new Map<string, IrExpr>();
  const assigns = new Map<string, IrExpr[]>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind === "assign") {
        const taken = assigns.get(node.localId);
        if (taken === undefined) assigns.set(node.localId, [node.value]);
        else taken.push(node.value);
        return true;
      }
      if (node.kind === "varDecl" && node.init !== null) definitions.set(node.localId, node.init);
      return true;
    },
  });
  for (const [localId, values] of assigns) {
    // A local assigned more than once could hold anything by the write.
    if (values.length === 1) definitions.set(localId, values[0]!);
    else definitions.delete(localId);
  }
  let found = false;
  everyStmtList(fn.body, {
    expr: (node) => {
      if (found) return false;
      const op = ownMemberOp(node);
      if (op === undefined) return true;
      const name = op.key === undefined ? undefined : spelledMemberName(op.key, definitions);
      if (name !== undefined && FN_REVEALED_BY_DELETE.has(name)) {
        found =
          node.kind === "libCall" &&
          (node.fn === "dyn.keyDelete" || node.fn === "dyn.keyDeleteComputed");
        return !found;
      }
      if (name === undefined || !FN_OWN_MEMBER_NAMES.has(name)) return true;
      // A definition also has to name a receiver that can be a function. A
      // typed record, bytes value, handle or collection boxes to an object,
      // but class and object lowering also define `constructor` on plain
      // objects, so a boxed non-callable proves the function-property path
      // never sees it. A checked-dynamic receiver proves nothing: an
      // any-typed function is one of the values it holds. A keyed write is
      // the shadow itself once it spells the name.
      found = op.definition ? mayHoldCallable(op.target) : true;
      return !found;
    },
    stmt: () => !found,
  });
  return found;
}

/** One rule per runtime feature, sorted by name. A new feature is an
 * entry here and its line in noRuntimeFeatures; RuntimeFeatures, the scan
 * and its early exit derive from this table. The lists above keep one
 * entry per line, sorted within each commented group, so changes that add
 * different entries touch different lines. */
const RUNTIME_FEATURE_RULES = {
  assert: rule({ prefixes: ["assert."] }),
  /** The program enters AsyncLocalStorage stores (store.run, enterWith,
   * a diagnostics_channel store binding) or reads the test runner's
   * context (getTestContext): its timer, immediate, tick and
   * queueMicrotask scheduling goes through the runtime's *_als entry
   * points, which carry the active stores into each callback. */
  asyncContext: rule({ fns: [...ASYNC_CONTEXT_LIB_FNS] }),
  /** scr_wasm.c converts i64 values through BigInt, and BigIntStats reads
   * produce bigint values. */
  bigint: rule({
    fns: ["process.hrtimeValue"],
    prefixes: ["bigint.", "wasm.", "bigstats."],
    types: ["bigint"],
  }),
  /** BigIntStats member reads (`statSync(p, { bigint: true })` members) link
   * scr_stats_bigint.c. The bigint feature is broader than this unit: every
   * bigint value and wasm conversion turns it on, so gating the unit on it
   * would link the getters into programs that never name a stat member. */
  bigstats: rule({ prefixes: ["bigstats."] }),
  childProcess: rule({
    fns: [...CHILD_PROCESS_LIB_FNS],
    prefixes: CHILD_PROCESS_LIB_PREFIXES,
    types: ["child", "childStream", "childWriter", "spawnRes"],
  }),
  /** ChildProcess listener removal (off/removeListener) and the recorded
   * terminal signal (signalCode): scr_child_lifecycle.c, a unit of its
   * own so a program that never calls them keeps scr_child.c's layout. */
  childLifecycle: rule({
    fns: [
      "child.offSpawn",
      "child.offExit",
      "child.offClose",
      "child.offError",
      "child.signalCode",
    ],
  }),
  /** process.features read as a value (an alias, `in`, Object.keys): the
   * stable flags object of scr_process_features.c, a unit of its own so
   * every other program keeps scr_lib.c's object. A member read
   * (`process.features.tls`) is a constant and links nothing. */
  processFeatures: rule({ fns: ["process.features"] }),
  /** spawnSync's and the exec/execFile callback form's `cwd`/`input`/
   * `shell` entries (SCR_CHILD_CP_OPTIONS): a build of scr_child.c of its
   * own, so a program that never passes those options keeps the default
   * object, byte for byte. */
  childOptionExt: rule({
    fns: ["cp.spawnSyncExt", "cp.spawnSyncExtEnv", "cp.execFileCwd"],
  }),
  /** A spawnSync capture read as a Buffer (spawnSync without an encoding
   * option): scr_child_capture.c, a unit of its own so a program that never
   * reads a capture keeps scr_child.c's layout — the memo's thread-local
   * state and its functions would otherwise move every symbol the linker
   * lays out after them. */
  spawnCaptureBytes: rule({
    fns: ["spawnRes.stdoutBytes", "spawnRes.stderrBytes"],
  }),
  /** The spawnSync result's `.error` property answers Node's
   * errnoException fields (errno, syscall, path, spawnargs). The fields
   * ride a build of scr_child.c of their own (SCR_CHILD_ERR_FIELDS), so a
   * program that never reads `.error` keeps the default object and the
   * result container exactly as they were. */
  childErrorFields: rule({ fns: ["spawnRes.error"] }),
  /** pause(), resume(), isPaused() and readableFlowing on a child's output
   * stream: Node's flowing state lives on the handle in a build of
   * scr_child.c of its own (SCR_CHILD_STREAM_FLOW), so a program that never
   * calls them keeps the default object, where a stream reads its pipe only
   * while it has a 'data' listener and holds nothing back. */
  childStreamFlow: rule({
    fns: ["stream.childPause", "stream.childResume", "stream.childIsPaused", "stream.childFlowing"],
  }),
  /** The program can register an 'error' listener on a ChildProcess: a
   * typed or an untyped registration, or a child that converts to an
   * untyped value, whose `on` the handle table serves. Such a program
   * installs the builder of a failed spawn's error object at start
   * (scr_child_error_event_install: errno, code, syscall, path and
   * spawnargs, one object for every listener). The settle path reaches
   * the builder only through that hook, so a program that spawns and can
   * never listen for 'error' links none of the property code. No unit and
   * no build of its own: the fact only decides the emitted call. */
  childErrorEvent: rule({
    fns: ["child.onError", "child.onDyn", "child.propsOnDyn"],
    expr: (node, tables) => node.kind === "dynFrom" && mentionsChild(node.value.type, tables()),
  }),
  /** scr_cipher.c over the mbedTLS archive; DEP0182 reports through the
   * process-warning unit, and unknown output encodings render through the
   * inspect unit. WebCrypto's encrypt, decrypt, wrapKey and unwrapKey
   * (scr_webcrypto_aes.c) link the same archive. */
  cipher: rule({
    fns: [
      "crypto.cipherNew",
      "webcrypto.encrypt",
      "webcrypto.decrypt",
      "webcrypto.wrapKey",
      "webcrypto.unwrapKey",
    ],
  }),
  copying: rule({
    expr: (node, _tables) =>
      (node.kind === "arrIntrinsic" && COPYING_ARR_METHODS.has(node.method)) ||
      (node.kind === "bytesIntrinsic" && COPYING_BYTES_METHODS.has(node.method)),
  }),
  dc: rule({ prefixes: ["dc."] }),
  /** dns.lookup lives in the dgram unit. */
  dgram: rule({ prefixes: ["dgram.", "dns."], types: ["dgramSocket"] }),
  /** A dgram socket converts to or from an untyped value (its handle box,
   * a boxed function or record that carries one): scr_dgram_dyn.c over
   * the dgram unit. */
  dgramDyn: rule({
    expr: (node, tables) =>
      (node.kind === "dynFrom" && mentionsDgramSocket(node.value.type, tables())) ||
      (node.kind === "dynCheck" && mentionsDgramSocket(node.type, tables())),
  }),
  /** A TextEncoder, TextDecoder or StringDecoder record converts to or from an untyped
   * value (its handle box, or a boxed function, record or collection that
   * carries one): scr_text_codec_dyn.c. */
  textCodecDyn: rule({
    fns: ["text.codecIs"],
    expr: (node, tables) =>
      (node.kind === "dynFrom" && mentionsTextCodec(node.value.type, tables())) ||
      (node.kind === "dynCheck" && mentionsTextCodec(node.type, tables())),
  }),
  /** node:dns/promises: scr_dns_promises.c over the dgram unit. */
  dnsPromises: rule({ fns: ["dns.promisesLookup", "dns.promisesLookupService"] }),
  dynAsync: rule({
    initial: (mod) =>
      mod.workers === true ||
      mod.functions.some(
        (fn) => fn.async === true && fn.generator === undefined && fn.returnType.kind === "dyn",
      ),
    // The legacy url functions, crypto.createCipheriv,
    // ecdh.setPublicKey and generateKeyPair's rsa-pss options emit their
    // deprecation warnings through the dyn-async unit (WebCrypto's
    // encrypt and decrypt link scr_cipher.c too); scr_wasm.c boxes its
    // handles and promises through it.
    fns: [
      ...DYN_ASYNC_LIB_FNS,
      ...READABLE_DYN_ASYNC_LIB_FNS,
      ...LEGACY_URL_LIB_FNS,
      "crypto.cipherNew",
      "webcrypto.encrypt",
      "webcrypto.decrypt",
      "webcrypto.wrapKey",
      "webcrypto.unwrapKey",
      "crypto.ecdhNew",
      "crypto.generateKeyPairCb",
      "crypto.generateKeyPairSync",
      // existsSync's DEP0187 report (scr_fs_exists_dyn.c) defers through
      // this unit's warning queue.
      "fs.existsSyncValue",
      // A rejected entry's reason crosses as a checked-dynamic value
      // (Promise.allSettled's tuple form).
      "promise.entryReason",
    ],
    prefixes: [...READABLE_DYN_ASYNC_PREFIXES, "wasm."],
    expr: (node, tables) =>
      (node.kind === "awaitExpr" && node.type.kind === "dyn") ||
      // Rejection reasons cross as dyn values (allSettled's records, any's
      // AggregateError list).
      (node.kind === "intrinsic" &&
        (node.name === "promise.allSettled" || node.name === "promise.any")) ||
      (node.kind === "dynFrom" && boxesPromise(node.value.type, tables(), new Set())) ||
      // The resolve function of a promise that may be given a promise
      // adopts it (scr_make_resolve_dyn, and scr_resolve_adopt for a typed
      // promise).
      (node.kind === "newPromise" && node.resolves === true) ||
      (node.kind === "promiseWithResolvers" && resolversOfDyn(node.type, tables())),
  }),
  /** The Promise statics through Function.prototype.call with a foreign
   * constructor (scr_js_promise_generic.c): NewPromiseCapability(C), the
   * C.resolve lookup and the iterator protocol. */
  promiseGeneric: rule({ fns: ["promise.genericStatic"] }),
  /** EventEmitter and the stream classes as untyped constructor values
   * (scr_dyn_builtin_class.c), which call listeners through the dyn-invoke
   * unit, render unhandled 'error' payloads through the inspect unit and
   * create EventEmitter's private symbols through the symbol unit. */
  dynBuiltinClass: rule({
    fns: [...BUILTIN_CLASS_LIB_FNS],
  }),
  /** The stream classes as untyped constructor values with their stream
   * half (scr_dyn_builtin_stream.c): native stream state for constructor
   * functions, over the stream unit. */
  dynBuiltinStream: rule({ fns: ["dyn.builtinStreamClass"] }),
  /** A standard library prototype object read as a value in a JavaScript
   * source (scr_dyn_stdlib_prototype.c): `Date.prototype`. */
  stdlibPrototypeValue: rule({ fns: ["dyn.stdlibPrototype"] }),
  /** DataView.prototype read as a value in a JavaScript source, and its
   * members through it (scr_data_view_proto.c): the getter/setter family's
   * prototype object. */
  dataViewPrototypeValue: rule({ fns: ["dyn.dataViewPrototype"] }),
  /** The dynamic global object's answer for the Node globals the native
   * runtime does not implement (scr_global_host_absent.c, plus the
   * SCR_GLOBAL_HOST_ABSENT build of scr_node_builtin.c): a computed read of
   * the global object, or `… in globalThis` (host-globals.ts). */
  hostAbsentGlobals: rule({ fns: ["global.hostAbsent", "dyn.globalHas"] }),
  /** The stderr report of a deferred diagnostic that fires
   * (scr_deferred_fence.c): a runtimeFence whose message carries its
   * diagnostic's tag (deferred-fence.ts). */
  deferredFence: rule({ initial: moduleHasDeferredFence }),
  /** `fn.constructor = value` where the checker sees a function: the write
   * into the function's own property table (scr_dyn_fn_own.c). */
  functionOwnWrite: rule({ fns: ["dyn.fnOwnSet"] }),
  /** Array.prototype's generic algorithms over array-like receivers
   * (scr_dyn_array_like.c), which delegates every other name to the
   * dyn-invoke unit's array dispatch. */
  arrayLikeDispatch: rule({ fns: ["dyn.arrayLikeProtoCall"] }),
  /** A builtin prototype method as a function value (String's trim family,
   * RegExp's exec/test/toString; scr_dyn_builtin_methods.c). */
  builtinMethodValue: rule({ fns: ["dyn.builtinMethodValue"] }),
  dynInvoke: rule({
    initial: (mod) => mod.workers === true,
    scan: computedBufferMemberScan,
    fns: [
      ...DYN_INVOKE_LIB_FNS,
      ...UTIL_CALLABLE_LIB_FNS,
      ...BUILTIN_CLASS_LIB_FNS,
      "util.promisifyDyn",
      "buffer.prototypeMember",
      "buffer.prototypeObject",
      // scr_webstreams.c calls the iterators ReadableStream.from reads.
      "webstream.class",
      "webstream.from",
      "webstream.instanceOf",
      "webstream.install",
      // scr_js_wrapper.c answers other values' tags through
      // scr_dyn_object_tag_of, and its prototype methods call scr_dyn_invoke.
      "wrapper.objectTag",
      "wrapper.new",
      "wrapper.toObject",
      // The Boolean prototype's methods run scr_js_wrapper_apply in the
      // same unit, which calls scr_dyn_invoke.
      "wrapper.booleanPrototype",
      // The generic Promise statics call C's resolve and the iterable's
      // next/return through scr_dyn_invoke.
      "promise.genericStatic",
    ],
    // Constant-key reads of Object.prototype member names, and of
    // Array.prototype method names on arrays, answer the inherited member
    // through scr_dyn_invoke.c.
    expr: (node, _tables) =>
      node.kind === "dynInvoke" ||
      (node.kind === "dynKeyGet" &&
        node.key.kind === "strLit" &&
        (INHERITED_MEMBER_NAMES.has(node.key.value) ||
          ARRAY_PROTOTYPE_MEMBER_NAMES.has(node.key.value))),
  }),
  /** The program has dynamic-tier jsval operations (js.* builtins, the
   * jsval pass): links the scr_js_* units (two-tier design I3). */
  dynTier: rule({ prefixes: ["js."] }),
  /** Checked-dynamic stream slots test values and pipe into JavaScript
   * stream objects (scr_stream_dyn.c). */
  streamDyn: rule({
    fns: ["stream.dynNative", "stream.dynNativePipe", "stream.pipeDyn", "stream.unpipeDyn"],
  }),
  /** Own properties JavaScript adds to runtime handles (scr_dyn_handle_props.c):
   * a Date, RegExp, Map, Set, weak collection, buffer or child. */
  handleProps: rule({ fns: ["handle.propsInstall", "handle.propsGrant"] }),
  /** Adoption (scr_decl_adopt.c): a dynamic object or array converted to a
   * record or array becomes a live capsule of the converted value. Linked
   * by the declaration-typed boundary's casts (and its boxed closures,
   * which adopt their arguments) and by every checked conversion at a typed
   * slot that shares its source. */
  declAdopt: rule({
    fns: ["dyn.declAdopt", "dyn.adoptShared", "dyn.adoptable"],
    initial: (mod) => mod.declBoundary === true,
    expr: (node) => node.kind === "dynCheck" && node.shared === true,
  }),
  // Checked conversions into package-declared types name the declaration
  // in their TypeError (scr_type_origin.c).
  typeOrigins: rule({ initial: (mod) => (mod.declOrigins?.length ?? 0) > 0 }),
  /** for await over checked-dynamic values (scr_dyn_for_await.c). */
  dynForAwait: rule({ fns: ["dyn.asyncIteratorOpen", "dyn.asyncIteratorWasSync"] }),
  /** A keyed collection's prototype as a value, Map.prototype's members,
   * the constructors' adder lookup and the ES2025 Set compositions over a
   * set-like (scr_dyn_collections.c). The unit calls into the dyn-invoke
   * unit for prototype members and the symbol unit for Symbol.iterator and
   * Symbol.toStringTag, so each of those rules lists these entry points
   * too. */
  dynCollections: rule({ fns: [...DYN_COLLECTION_LIB_FNS] }),
  /** Object.isExtensible and Object.isSealed of a value typed dynamically
   * (scr_dyn_integrity.c, a unit of its own so scr_json.c keeps its layout). */
  dynIntegrityQueries: rule({ fns: ["dyn.isExtensibleQuery", "dyn.isSealedQuery"] }),
  /** Reflect.getPrototypeOf's primitive-target check (scr_dyn_reflect_proto.c,
   * a unit of its own so scr_json.c keeps its layout). */
  reflectProtoTarget: rule({ fns: ["dyn.reflectGetPrototypeTarget"] }),
  /** `delete` of a key a record's type does not declare, removed from the
   * record's kept source (scr_record_source_delete.c, a unit of its own so
   * scr_json.c keeps its layout). */
  recordSourceDelete: rule({ fns: ["record.sourceDelete"] }),
  /** A partial record assertion to a type whose values may be frozen
   * (scr_record_view_frozen.c): a view of such a type shares the frozen bit
   * with frozen records, and the unit tells the two apart. The frontend
   * keeps the asserted type and the literal's own type freezable together
   * (frozen-records.ts), so the asserted type decides. */
  recordViewFrozen: rule({
    expr: (node, tables) =>
      node.kind === "dynCheck" &&
      node.partialView === true &&
      node.type.kind === "record" &&
      tables().records.get(node.type.shapeId)?.freezable === true,
  }),
  /** A generator that binds its parameters at the call (scr_gen_bind.c):
   * the spawn wrapper's eager step imports the bind helper, and every other
   * program links the default runtime objects. */
  genBind: rule({
    initial: (mod) => mod.functions.some((fn) => fn.generator?.bindAtCall === true),
  }),
  /** A generator function reads `this` (dyn.generatorThis): its body runs
   * on the generator's fiber after the call returned, so the program's
   * spawn wrappers record the call's receiver (scr_gen_capture_receiver).
   * A program without the read records none: its generators take no
   * dynamic value. */
  genReceiver: rule({ fns: ["dyn.generatorThis"] }),
  /** Buffer.prototype methods called on checked-dynamic values
   * (scr_bytes_dyn.c). */
  dynBuffer: rule({
    // Buffer.prototype members read as values, and Buffer members read with
    // a computed key, dispatch to the same entries.
    fns: ["buffer.prototypeMember", "buffer.prototypeObject"],
    scan: computedBufferMemberScan,
    expr: (node, _tables) => node.kind === "dynInvoke" && DYN_BUFFER_METHODS.has(node.method),
  }),
  /** Checked-dynamic reads that answer Buffer.prototype methods by name
   * (`buf[name]`, `buf.indexOf` as a value, Buffer.prototype): the program
   * installs scr_bytes_dyn.c's member hook, which references every
   * scr_dyn_invoke_buffer entry. */
  dynBufferMembers: rule({
    fns: ["buffer.prototypeMember", "buffer.prototypeObject"],
    scan: computedBufferMemberScan,
  }),
  /** Buffer.prototype as a value: the program installs the symbol unit's
   * Symbol.for for scr_bytes_dyn.c, which registers
   * Symbol(nodejs.util.inspect.custom) as one of its keys. */
  bufferPrototypeObject: rule({ fns: ["buffer.prototypeObject"] }),
  /** createRequire's require and require.resolve with specifiers computed
   * at run time (scr_require.c). */
  computedRequire: rule({ fns: ["module.requireComputed", "module.resolveComputed"] }),
  /** An untyped path of a synchronous fs function in a JavaScript source
   * (scr_fs_path_value.c): a unit of its own, so no other executable
   * changes. */
  fsPathValue: rule({ fns: ["dyn.validateFsPath"] }),
  /** Builtin functions read as values (scr_builtin_values.c). */
  builtinValues: rule({
    fns: [
      "buffer.byteLenValue",
      "buffer.allocValue",
      "fs.realpathValue",
      "buffer.constructor",
      "buffer.installValue",
      "buffer.staticValue",
      "buffer.prototypeMember",
      "buffer.prototypeObject",
      "dyn.validateString",
      "dyn.validateStrings",
      "path.resolveValue",
      "path.parseValue",
      "path.formatValue",
      "path.toNamespacedValue",
      "dyn.installBuiltinStatics",
    ],
  }),
  /** The stream unit emits through the emitter unit, also when the
   * program constructs no stream (a pipeline of functions). */
  /** scr_ecdh.c over the mbedTLS archive; DEP0031 reports through the
   * process-warning unit, and unknown encodings and formats render through
   * the inspect unit. */
  ecdh: rule({ fns: ["crypto.ecdhNew", "crypto.ecdhConvertKey"] }),
  /** scr_dh.c over the mbedTLS archive, also for checkPrime and
   * generatePrime; unknown encodings and argument values render through
   * the inspect unit. */
  dh: rule({ fns: [...DH_LIB_FNS] }),
  emitter: rule({
    initial: (mod) =>
      mod.workers === true || (mod.classes ?? []).some((c) => c.name === RUNTIME_EMITTER_CLASS),
    fns: [...STREAM_LIB_FNS, ...BUILTIN_CLASS_LIB_FNS],
    prefixes: ["emitter.", ...STREAM_LIB_PREFIXES],
  }),
  /** Subclasses of the runtime EventTarget/Event bases tear down and box
   * through the EventTarget unit even when no event.* libCall survives. */
  eventTarget: rule({
    initial: (mod) =>
      (mod.classes ?? []).some(
        (c) => c.name === RUNTIME_EVENT_TARGET_CLASS || c.name === RUNTIME_EVENT_CLASS,
      ),
    // util.debounce and util.throttle register options.signal's listener.
    fns: [
      "events.addAbortListener",
      "util.aborted",
      "util.debounce",
      "util.throttle",
      ...ABORT_SIGNAL_LIB_FNS,
    ],
    prefixes: ["event."],
  }),
  /** util.MIMEType and util.MIMEParams (scr_mime.c). */
  mime: rule({ prefixes: ["mime."] }),
  /** Web streams in checked-dynamic code (scr_webstreams.c). */
  webStreams: rule({ prefixes: ["webstream."] }),
  /** A program that builds a Blob or File can hand one to fetch: selects
   * scr_fetch.c's SCR_WEB_BODIES build, which sends the blob's bytes and
   * type as Node does. Every other program keeps the default fetch unit,
   * byte for byte. */
  webBodies: rule({ prefixes: ["blob."] }),
  /** AbortController and AbortSignal (scr_abort.c, or the fetch unit).
   * A WritableStream controller's signal is one (scr_webstreams.c). */
  abortSignal: rule({ prefixes: ["abort.", "webstream."] }),
  /** util.debounce and util.throttle (scr_util_timing.c). */
  utilTiming: rule({ fns: ["util.debounce", "util.throttle"] }),
  /** events.once(emitter, name, { signal }) (scr_events_once_signal.c). */
  eventsOnceSignal: rule({ fns: ["events.onceSignal"] }),
  fetch: rule({ prefixes: ["fetch."] }),
  fileHandle: rule({ types: ["fileHandle"] }),
  fsWatch: rule({ prefixes: ["fs.watch", "watcher."], types: ["fsWatcher"] }),
  /** fs.watchFile / fs.unwatchFile (scr_watch_file.c): the stat-polling
   * half of the watching surface, gated on its own unit. */
  fsWatchFile: rule({ fns: ["fs.watchFile", "fs.unwatchFile"] }),
  /** A socket 'lookup' listener: the C main installs the net unit's
   * lookup records (scr_net_lookup_install). */
  netLookup: rule({ fns: ["net.sockOnLookup"] }),
  http: rule({
    prefixes: ["http.", "tls.", "https.", "http2."],
    types: ["httpReq", "httpRes", "httpClientReq", "secureCtx"],
  }),
  /** The real h2 surface (scr_http2.c); the legacy http2.* libCalls of the
   * allowHTTP1 slice are served by scr_http.c and scr_tls.c. */
  http2: rule({
    libCall: (node) => node.fn.startsWith("http2.") && !HTTP2_LEGACY_FNS.has(node.fn),
    types: ["http2Session", "http2Stream"],
  }),
  /** Intl over ICU: scr_intl.c plus the ICU archive and the data
   * file that ships beside the executable. The prefix is `icu.` because the
   * `intl.` libCalls are the engine-free fast paths — the embedded en-US
   * number format and the table-driven grapheme segmenter — which must keep
   * linking no ICU code. */
  icu: rule({ prefixes: ["icu."] }),
  /** scr_test.c renders thrown strings with the inspect unit's string
   * formatting; scr_util_callable.c wraps the inspect unit; readline's
   * terminal unit prints completion errors through it when there is a
   * completer. */
  inspect: rule({
    fns: [
      "global.native",
      // formatBigInt renders a bigint's digits in Node's form, and the
      // numericSeparator groups they take are inspect state.
      "bigint.inspect",
      // ERR_ARG_NOT_ITERABLE renders the value as util.format's %s does.
      "webstream.class",
      "webstream.from",
      // ERR_UNKNOWN_ENCODING formats an encoding that is not a string with %s.
      "strdec.encodingValue",
      "webstream.install",
      "util.styleText",
      // ERR_UNHANDLED_ERROR quotes util.inspect of a non-Error payload.
      "emitter.emitErrorValue",
      "crypto.cipherNew",
      "webcrypto.encrypt",
      "webcrypto.decrypt",
      "webcrypto.wrapKey",
      "webcrypto.unwrapKey",
      "crypto.ecdhNew",
      "crypto.ecdhConvertKey",
      ...DH_LIB_FNS,
      ...BUILTIN_CLASS_LIB_FNS,
      ...UTIL_CALLABLE_LIB_FNS,
    ],
    prefixes: ["insp.", "console.", "test."],
    libCall: (node) => node.fn === "rl.terminal" && !isDynUndefined(node.args[3]!),
  }),
  /** The JavaScript object model build (t262-da §J): every runtime feature
   * only a JavaScript source reaches shares one SCR_JS_OBJECT_MODEL build
   * of the units it touches, so a program with one of them selects that
   * build rather than a variant column of its own. The program has no
   * typed-to-dynamic bridge of its own to lose: jsObjectModel implies
   * dynTier. */
  jsObjectModel: rule({ fns: [...JS_OBJECT_MODEL_LIB_FNS] }),
  legacyTextDecoder: rule({
    fns: [...LEGACY_TEXT_DECODER_LIB_FNS],
    // A TextDecoderStream decodes whatever encoding it was constructed with:
    // its transform calls scr_text_decode_stream, whose UTF-8 half is the
    // default build and whose other encodings are the legacy one.
    libCall: (node) =>
      node.fn === "webstream.class" &&
      node.args[0]?.kind === "numLit" &&
      node.args[0].value === TEXT_DECODER_STREAM_CLASS,
    expr: (node, tables) =>
      (node.kind === "dynFrom" && mentionsTextDecoder(node.value.type, tables())) ||
      (node.kind === "dynCheck" && mentionsTextDecoder(node.type, tables())),
  }),
  /** The program calls mock.timers members: its timer calls go through
   * scr_test.c's mock-aware entry points. */
  mockTimers: rule({ prefixes: ["test.mockTimers", "test.ctxMockTimers"] }),
  net: rule({
    prefixes: NET_PREFIXES,
    types: [
      "netServer",
      "netSocket",
      "http2Session",
      "http2Stream",
      "httpReq",
      "httpRes",
      "httpClientReq",
      "secureCtx",
    ],
  }),
  /** Calls into Node.js (@scriptc/node): scr_node_island.c and the
   * SCR_NODE_ISLANDS build of the event loop unit. */
  nodeIsland: rule({ prefixes: ["nodeIsland."] }),
  nodeTest: rule({ prefixes: ["test."], types: ["testCtx"] }),
  /** scr_util_callable.c reads options through the parseArgs unit's
   * descriptors. */
  parseArgs: rule({ fns: [...PARSE_ARGS_LIB_FNS, ...UTIL_CALLABLE_LIB_FNS] }),
  /** perf_hooks event-loop metrics (eventLoopUtilization,
   * monitorEventLoopDelay): scr_perf_loop.c. */
  perfLoop: rule({ fns: ["perf.idleTime"], prefixes: ["perf.loop", "perf.eld"] }),
  /** scr_pki.c over the mbedTLS archive: asymmetric KeyObjects and
   * signatures. */
  pki: rule({ scan: webCryptoAsymmetricScan, fns: [...PKI_LIB_FNS] }),
  /** scr_ed25519.c (the vendored libsodium Ed25519), linked with pki: a
   * string literal in the module names Ed25519. */
  ed25519: rule({ scan: ed25519NameScan }),
  processEvents: rule({ fns: [...PROCESS_EVENT_LIB_FNS, "util.styleText"], types: ["procStream"] }),
  /** scr_url_legacy.c parses and stringifies queries. */
  qs: rule({ fns: [...QS_LIB_FNS, ...LEGACY_URL_LIB_FNS] }),
  /** The kept-source read of a record-to-record conversion: a field the
   * target type declares and the source type does not answers the key the
   * source object carries, after asking whether the source holds the key
   * (scr_record_source_get.c). A unit of its own so a program that only
   * casts records keeps its base runtime objects byte for byte. */
  recordSourceGet: rule({ fns: ["record.sourceGet", "record.sourceHasKey"] }),
  /** scr_url_legacy.c lowercases and normalizes hostnames with the regex
   * unit's libunicode, the WHATWG URL host parser runs UTS #46 through
   * scr_idna.c (which links with the regex unit), NODE_DEBUG matching in
   * scr_util_callable.c and readline's terminal unit use the regex unit,
   * and locale case mapping runs its default conversion. */
  regex: rule({
    fns: [
      ...REGEX_LIB_FNS,
      ...LEGACY_URL_LIB_FNS,
      ...UTIL_CALLABLE_LIB_FNS,
      "rl.terminal",
      "str.localeCase",
      // win32.relative compares with String.prototype.toLowerCase's
      // Unicode case mapping.
      "path.win32Relative",
    ],
    prefixes: URL_PREFIXES,
    expr: (node, _tables) =>
      node.kind === "regexLit" ||
      node.kind === "regexIntrinsic" ||
      (node.kind === "strIntrinsic" && CASE_MAPPING_STR_METHODS.has(node.method)),
    types: ["regex", "url"],
  }),
  searchParams: rule({ fns: ["url.searchParams"], prefixes: ["sp."], types: ["searchParams"] }),
  /** URL programs install the IDNA unit's ToASCII for the WHATWG host
   * parser (scr_url_idna_install). */
  urlIdna: rule({ prefixes: URL_PREFIXES, types: ["url"] }),
  /** A write completion callback that takes the error argument lowers
   * through writable.writeEcb: the SCR_STREAM_WRITE_ERRORS stream unit
   * publishes the error the adapter delivers. */
  streamWriteErrors: rule({ fns: ["writable.writeEcb"] }),
  /** The program can pipe or unpipe a stream: pipe(), unpipe(), pipeline()
   * and compose() in every form, a call of a member named pipe or unpipe
   * (or a computed member) on an untyped value, which can reach a native
   * stream's own method, and either name as a string. It links
   * scr_stream_pipe_events.c, which installs Node's pipe lifecycle into
   * the stream unit: the destination hears 'unpipe' when it finishes,
   * closes or errors, and unpipe pauses the source as Node's does. A
   * program that never pipes links none of it. */
  streamPipeEvents: rule({
    fns: [
      "readable.pipe",
      "readable.pipeGeneral",
      "readable.unpipe",
      "stream.pipeline",
      "stream.pipelineDyn",
      "stream.pipelineStages",
      "stream.pipelineStagesDyn",
      "stream.compose",
      "stream.composeStages",
      "sp.pipeline",
      "sp.pipelineOpts",
      "sp.pipelineOptsSignal",
      "sp.pipelineStages",
      "sp.pipelineStagesOpts",
    ],
    expr: (node) =>
      (node.kind === "dynInvoke" &&
        (node.method === "pipe" ||
          node.method === "unpipe" ||
          node.calleeNameValue !== undefined)) ||
      (node.kind === "strLit" && (node.value === "pipe" || node.value === "unpipe")),
  }),
  /** An fs.ReadStream or fs.WriteStream whose options can hold a `signal`
   * (the options name it, or their type admits it): the
   * SCR_FS_STREAM_SIGNAL build of scr_fs_stream.c applies the signal as
   * Node's stream constructors do. The same calls link the event-target
   * unit (ABORT_SIGNAL_LIB_FNS), whose addAbortListener that build calls.
   * Every other program keeps the default fs stream unit, byte for byte. */
  fsStreamSignal: rule({
    fns: [
      "fs.createReadStreamSignal",
      "fs.createWriteStreamSignal",
      "fileHandle.createReadStreamSignal",
      "fileHandle.createWriteStreamSignal",
    ],
  }),

  /** The program holds a process output stream as a value: the
   * process.stdio lib call, process.stdioSlot for the write method's own
   * lowering, or a value of the process stream type, which becomes the
   * stream object when it is boxed (dyn.ts). Those are the only ways to the
   * stream object, and a replacement of its write method is a store into
   * that object, so this covers every program that can replace
   * process.stdout.write or process.stderr.write, whichever spelling, alias
   * or computed key the replacement uses. Beside
   * `nodeIsland` it links scr_node_island_stdio.c and the
   * SCR_NODE_ISLAND_STDIO build of scr_node_island.c, which make the
   * island's two output streams read and write the program's write slots;
   * every other program with islands keeps its island units unchanged. */
  stdioObject: rule({ fns: ["process.stdio", "process.stdioSlot"], types: ["procStream"] }),
  /** The program holds a process stream as a value and names getColorDepth
   * or hasColors: links scr_tty_colors.c (Node's color rules over an
   * environment object) and the SCR_TTY_COLORS build of scr_events.c, whose
   * stream object has the two methods on a terminal. Every other program
   * keeps the default events unit, byte for byte, and its stream object
   * answers undefined for the two names. */
  ttyColors: rule({ scan: terminalColorMethodScan }),

  stream: rule({
    initial: (mod) => (mod.classes ?? []).some((c) => RUNTIME_STREAM_CLASSES.has(c.name)),
    fns: [...STREAM_LIB_FNS, "dyn.builtinStreamClass"],
    prefixes: STREAM_LIB_PREFIXES,
  }),
  /** A Dirent row converted to dyn carries Node's Symbol(type) key
   * (scr_dyn_dirent_finish, defined in scr_symbol.c), and a callback read
   * builds its Dirent there. */
  symbol: rule({
    initial: (mod) => (mod.records ?? []).some(isDirentShape),
    fns: [...SYMBOL_LIB_FNS, "dir.readCb"],
    // %Iterator.prototype% (scr_js_iterator.c) defines its Symbol.iterator,
    // Symbol.toStringTag and Symbol.dispose members with the well-known
    // symbols scr_sym_well_known makes. An island symbol the program
    // receives is a native symbol (scr_node_island_handle.c makes it), so
    // a program with a Node island links the unit too.
    prefixes: ["sym.", "disposable.", "iterator.", "nodeIsland."],
    types: ["symbol"],
  }),
  /** Symbol.toPrimitive is read (sym.wellKnown with that name, or a name
   * computed at run time): the program installs ToNumber's
   * Symbol.toPrimitive step (scr_dyn_to_primitive_number_install). */
  toPrimitiveNumber: rule({
    libCall: (node) =>
      node.fn === "sym.wellKnown" &&
      (node.args[0]?.kind !== "strLit" || node.args[0].value === "toPrimitive"),
  }),
  tls: rule({ prefixes: ["tls.", "https.", "http2."], types: ["secureCtx"] }),
  tlsCa: rule({ prefixes: ["tlsca."] }),
  /** util.promisify over an untyped function (scr_util_promisify.c): its
   * promises go through the dyn-async unit and its calls through the
   * dyn-invoke unit. */
  utilPromisify: rule({ fns: ["util.promisifyDyn"] }),
  /** process.emitWarning is assigned (process.setEmitWarning). */
  warningReplace: rule({ fns: ["process.setEmitWarning"] }),
  /** A BigInt typed-array constructor read as a value (BigInt64Array,
   * BigUint64Array): their element kinds, which no double represents, live
   * in the JavaScript object model build (t262-da §J) of scr_bytes.c,
   * scr_json.c, scr_dyn_invoke.c and the assert, inspect and console units.
   * The fact ORs into jsObjectModel (jsObjectModelFact), so it selects no
   * build column of its own. Every other program keeps the byte-for-byte
   * default objects. */
  bigintBytes: rule({
    libCall: (node) =>
      node.fn === "bytes.constructor" &&
      node.args[0]?.kind === "strLit" &&
      BIGINT_BYTES_NAMES.has(node.args[0].value),
  }),
  /** `new Promise` whose executor takes a checked-dynamic reject parameter,
   * and `Promise.withResolvers` on a checked-dynamic promise whose resolver
   * record does: that reason is the program's own value, not an Error, so
   * the emitter builds the reject closure with scr_make_reject_dyn — which
   * lives in the SCR_PROMISE_REJECT_DYN build of scr_async.c. A promise
   * lowered with an Error-taking reject (the typed `util.promisify` family,
   * even for an unknown settled value; any typed `withResolvers`) keeps the
   * default object. Every other program links the default object, byte for
   * byte. */
  promiseRejectDyn: rule({
    expr: (node, tables) => {
      if (node.kind === "newPromise")
        return (
          node.type.kind === "promise" &&
          node.type.inner.kind === "dyn" &&
          node.executor.type.kind === "func" &&
          node.executor.type.params.length === 2 &&
          node.executor.type.params[1] !== undefined &&
          node.executor.type.params[1].kind === "func" &&
          node.executor.type.params[1].params[0] !== undefined &&
          node.executor.type.params[1].params[0].kind === "dyn"
        );
      if (node.kind !== "promiseWithResolvers" || node.type.kind !== "record") return false;
      const shape = tables().records.get(node.type.shapeId);
      const promT = shape?.fields.find((f) => f.name === "promise")?.type;
      const rejectT = shape?.fields.find((f) => f.name === "reject")?.type;
      return (
        promT?.kind === "promise" &&
        promT.inner.kind === "dyn" &&
        rejectT?.kind === "func" &&
        rejectT.params[0]?.kind === "dyn"
      );
    },
  }),
  /** Sparse arrays (t262 W7): an array whose length exceeds its dense
   * prefix. Only a checked-dynamic member write can produce one, and only a
   * write the source spells an index proves it: a key computed at run time
   * (`a[k] = v`) may name any index, so proving sparseness from it would
   * select this build for every program with a computed write. The elements
   * past the prefix live in the JavaScript object model build (t262-da §J)
   * of scr_json.c and scr_dyn_invoke.c, and that build's keyed read answers
   * `length` from the array's own length instead of the prefix field. The
   * fact ORs into jsObjectModel (jsObjectModelFact), so it selects no build
   * column of its own. Every program that exists today keeps its build:
   * a spelled index or `length` the runtime can place densely stays in the
   * default objects, and a computed one keeps its SC2020 refusal. */
  sparseArrays: rule({ initial: (mod) => moduleWritesSparseIndex(mod) }),
  /** Module namespace objects as checked-dynamic values
   * (scr_module_namespace.c). */
  moduleNamespace: rule({ fns: ["module.namespaceValue"] }),
  /** A JavaScript source resizes, grows or detaches an ArrayBuffer
   * (frontend/lowering/buffers.ts): the program arms the buffer views
   * registry, which lives in the gated unit scr_js_buffers.c, and its bytes
   * headers stop being invariant (IrModule.bytesHeadersMutable). The fact
   * ORs into jsObjectModel (jsObjectModelFact), so it selects no build
   * column of its own. Every other program links no part of the unit. */
  mutableBuffers: rule({
    fns: ["arrayBuffer.armMutable", "arrayBuffer.newResizable", "sharedArrayBuffer.newGrowable"],
  }),
  /** A module namespace boxed for typed code (scr_module_namespace_dyn.c). */
  moduleNamespaceDyn: rule({ fns: ["module.namespaceDyn"] }),
  /** Primitive wrapper objects (scr_js_wrapper.c), which also own
   * Number.prototype and Boolean.prototype: the value a JavaScript source
   * reads through dyn.builtinPrototype, and the compiled constructor's
   * `prototype` member of the same object. */
  primitiveWrapper: rule({ prefixes: ["wrapper."], fns: ["dyn.builtinPrototype"] }),
  /** %Iterator% and %Iterator.prototype% as values (scr_js_iterator.c). */
  iteratorProto: rule({ prefixes: ["iterator."] }),
  /** A JavaScript source reads or writes the member named `__proto__` by
   * that literal name on a dynamic value, or builds a literal member with
   * that name: Object.prototype's accessor answers the read with the
   * receiver's [[Prototype]] and the write by replacing it, while a literal
   * member is a property definition, both of which the object model build
   * models (scr_json.c, expr-dynamic.ts). The fact ORs into jsObjectModel
   * (jsObjectModelFact), so a program that names the member links that one
   * build; every other program keeps the default object, byte for byte. */
  protoAccessor: rule({
    expr: (node) =>
      (node.kind === "dynKeyGet" && isProtoKeyLiteral(node.key)) ||
      (node.kind === "dynObjLit" &&
        (node.fields ?? []).some((field) => isProtoKeyLiteral(field.key))),
    libCall: (node) =>
      PROTO_KEY_LIB_FNS.has(node.fn) && node.args.some((arg) => isProtoKeyLiteral(arg)),
  }),
  /** The WebAssembly API (scr_wasm.c). */
  wasm: rule({ prefixes: ["wasm."] }),
  /** crypto.subtle importKey/sign/verify/digest and CryptoKey:
   * scr_webcrypto.c. */
  webcrypto: rule({ prefixes: ["webcrypto."] }),
  /** scr_x509.c: the X509Certificate fields beyond the validity window and
   * fingerprint, which stay in scr_lib.c. */
  x509: rule({
    fns: [
      "crypto.x509Ca",
      "crypto.x509Fingerprint256",
      "crypto.x509Fingerprint512",
      "crypto.x509InfoAccess",
      "crypto.x509Issuer",
      "crypto.x509Raw",
      "crypto.x509RawDer",
      "crypto.x509RawStr",
      "crypto.x509SerialNumber",
      "crypto.x509SignatureAlgorithm",
      "crypto.x509SignatureAlgorithmOid",
      "crypto.x509Subject",
      "crypto.x509SubjectAltName",
      "crypto.x509CheckHost",
      "crypto.x509CheckEmail",
      "crypto.x509CheckIP",
      "crypto.x509CheckIssued",
      "crypto.x509LegacyObject",
      "crypto.x509Pem",
      // getPeerCertificate and getCertificate build with scr_x509.c too.
      "tls.sockGetPeerCertificate",
      "tls.sockGetCertificate",
    ],
  }),
  /** A program that writes, defines or deletes one of a function's
   * inherited member names (`fn.call = f`, `Object.defineProperty(fn,
   * "bind", …)`, `delete fn.apply`), reads `call` or `bind` as a value
   * through a spelled dynamic key (`typeof fn.call`), or deletes a
   * `toString`: the
   * SCR_FN_MEMBER_PROPS builds of scr_json.c (the member
   * write/define/delete, own-valueOf and inherited-value paths) and
   * scr_dyn_invoke.c (own call/apply/bind dispatch before the native
   * lowering). Every other program keeps both units' default objects, byte
   * for byte. */
  fnMemberProps: rule({ initial: (mod) => moduleShadowsFunctionMember(mod) }),
  /** writeFile's options record (`encoding`, `mode`, `flag`), appendFile's
   * three-argument form and copyFile's mode argument: scr_fs_flags.c and
   * the SCR_FS_FLAGS build of scr_fs_cp.c. Programs that never pass them
   * keep both units' default objects. */
  fsFlags: rule({
    fns: [
      "fs.copyFileFlagsSync",
      "fs.writeFileFlagsSync",
      "fs.writeFileOptionsSync",
      "fs.appendFileOptionsSync",
      "fs.writeFileBytesOptionsSync",
      "fs.appendFileBytesOptionsSync",
      "fs.writeFileSyncDataFlags",
      "fsp.writeFileDataFlags",
      "fs.writeFileDataOptionsSync",
      "fs.appendFileDataOptionsSync",
      "fsp.copyFileFlags",
      "fsp.writeFileFlags",
    ],
  }),
  /** existsSync over a path value that is not statically a string:
   * scr_fs_exists_dyn.c, which reports DEP0187 through the warning queue the
   * dynAsync rule brings in. */
  fsExistsValue: rule({ fns: ["fs.existsSyncValue"] }),
  /** node:module's compile cache family: scr_module_cache.c. */
  moduleCompileCache: rule({ prefixes: ["module.compileCache"] }),
  /** The BYTE-data and checked-data spellings of the options write and of
   * fs.promises.writeFile: scr_fs_bytes_write.c, so a program that writes no
   * byte payload keeps scr_fs_flags.c's and scr_bytes_io.c's objects byte
   * for byte. The unit carries its own static copy of scr_fs_flags.c's mode
   * and encoding validation. Its checked-data options forms call the string
   * and byte writers in scr_fs_flags.c, so those forms also turn fsFlags
   * on. */
  fsBytesWrites: rule({
    fns: [
      "fs.writeFileSyncBytesFlags",
      "fsp.writeFileBytes",
      "fsp.writeFileBytesFlags",
      "fs.writeFileSyncData",
      "fs.appendFileSyncData",
      "fs.writeFileSyncDataFlags",
      "fsp.writeFileData",
      "fsp.appendFileData",
      "fsp.writeFileDataFlags",
      "fs.writeFileDataOptionsSync",
      "fs.appendFileDataOptionsSync",
      "fs.writeFileSyncFdData",
    ],
  }),
  /** string_decoder's checked-dynamic chunk forms (a stream "data" payload):
   * scr_bytes_strdec_dyn.c. */
  strdecDyn: rule({ fns: ["strdec.nextDyn", "strdec.writeDyn"] }),
  /** The process and stream event registries' extras — prependListener for
   * signals, 'exit' and uncaught exceptions, stdin.isRaw, and the server
   * event registry's off/removeListener, listeners and 'newListener': the
   * SCR_PROCESS_EXTRAS build of scr_async_dyn.c, the SCR_NET_SERVER_OFF
   * build of scr_net.c and the SCR_HTTP_SERVER_META build of scr_http.c. */
  processExtras: rule({
    fns: [
      "net.serverOff",
      "net.serverOnNewListener",
      "net.serverListeners",
      "http.serverOff",
      "http.serverListeners",
      "process.prependExit",
      "process.prependSignal",
      "process.prependUncaughtException",
      "process.stdinIsRaw",
    ],
  }),
  zlib: rule({ prefixes: ["zlib."] }),
  /** node:zlib's Brotli forms: zlib.brotliInstall, which %main calls when
   * the program uses Brotli (scr_brotli.c). */
  brotli: rule({ fns: ["zlib.brotliInstall"] }),
  /** node:zlib's zstd forms: zlib.zstdInstall, which %main calls when the
   * program uses zstd (scr_zstd.c). */
  zstd: rule({ fns: ["zlib.zstdInstall"] }),
};

type RuntimeFeatureName = keyof typeof RUNTIME_FEATURE_RULES;

export type RuntimeFeatures = Record<RuntimeFeatureName, boolean>;

const RUNTIME_FEATURE_NAMES: RuntimeFeatureName[] = [];
for (const name in RUNTIME_FEATURE_RULES) RUNTIME_FEATURE_NAMES.push(name as RuntimeFeatureName);

/** Every feature off, in the table's order. TypeScript rejects this
 * literal when it misses a feature or names one without a rule. */
function noRuntimeFeatures(): RuntimeFeatures {
  return {
    assert: false,
    asyncContext: false,
    bigint: false,
    bigstats: false,
    childProcess: false,
    cipher: false,
    copying: false,
    dc: false,
    dgram: false,
    dgramDyn: false,
    textCodecDyn: false,
    dnsPromises: false,
    dynAsync: false,
    promiseGeneric: false,
    dynBuiltinClass: false,
    dynBuiltinStream: false,
    stdlibPrototypeValue: false,
    dataViewPrototypeValue: false,
    hostAbsentGlobals: false,
    deferredFence: false,
    functionOwnWrite: false,
    dynInvoke: false,
    arrayLikeDispatch: false,
    builtinMethodValue: false,
    dynTier: false,
    ecdh: false,
    x509: false,
    dh: false,
    emitter: false,
    eventTarget: false,
    eventsOnceSignal: false,
    fetch: false,
    fileHandle: false,
    fnMemberProps: false,
    fsFlags: false,
    fsExistsValue: false,
    moduleCompileCache: false,
    fsBytesWrites: false,
    fsWatch: false,
    fsWatchFile: false,
    genBind: false,
    http2: false,
    http: false,
    icu: false,
    inspect: false,
    jsObjectModel: false,
    mutableBuffers: false,
    legacyTextDecoder: false,
    mime: false,
    webBodies: false,
    webStreams: false,
    abortSignal: false,
    utilTiming: false,
    mockTimers: false,
    net: false,
    netLookup: false,
    nodeIsland: false,
    nodeTest: false,
    parseArgs: false,
    perfLoop: false,
    pki: false,
    ed25519: false,
    processEvents: false,
    processExtras: false,
    qs: false,
    recordSourceGet: false,
    regex: false,
    searchParams: false,
    urlIdna: false,
    stdioObject: false,
    ttyColors: false,
    streamWriteErrors: false,
    streamPipeEvents: false,
    fsStreamSignal: false,
    moduleNamespace: false,
    moduleNamespaceDyn: false,
    primitiveWrapper: false,
    iteratorProto: false,
    protoAccessor: false,
    stream: false,
    strdecDyn: false,
    streamDyn: false,
    handleProps: false,
    childLifecycle: false,
    processFeatures: false,
    childOptionExt: false,
    spawnCaptureBytes: false,
    childErrorFields: false,
    childStreamFlow: false,
    childErrorEvent: false,
    declAdopt: false,
    typeOrigins: false,
    dynForAwait: false,
    dynCollections: false,
    dynIntegrityQueries: false,
    reflectProtoTarget: false,
    recordSourceDelete: false,
    recordViewFrozen: false,
    dynBuffer: false,
    dynBufferMembers: false,
    genReceiver: false,
    bufferPrototypeObject: false,
    fsPathValue: false,
    builtinValues: false,
    computedRequire: false,
    symbol: false,
    toPrimitiveNumber: false,
    tls: false,
    tlsCa: false,
    utilPromisify: false,
    warningReplace: false,
    promiseRejectDyn: false,
    bigintBytes: false,
    sparseArrays: false,
    wasm: false,
    webcrypto: false,
    zlib: false,
    brotli: false,
    zstd: false,
  };
}

const ruleOf = (name: RuntimeFeatureName): RuntimeFeatureRule => RUNTIME_FEATURE_RULES[name];

/** The rules indexed for the scan: features by libCall name and by type
 * kind, and the prefix and predicate conditions in rule order. */
const FEATURES_BY_FN = new Map<string, RuntimeFeatureName[]>();
const FEATURES_BY_TYPE = new Map<string, RuntimeFeatureName[]>();
const FEATURE_PREFIXES: { prefix: string; name: RuntimeFeatureName }[] = [];
const FEATURE_LIBCALL_TESTS: RuntimeFeatureName[] = [];
const FEATURE_EXPR_TESTS: RuntimeFeatureName[] = [];
for (const name of RUNTIME_FEATURE_NAMES) {
  const rule = ruleOf(name);
  for (const fn of rule.fns ?? []) {
    const names = FEATURES_BY_FN.get(fn);
    if (names) names.push(name);
    else FEATURES_BY_FN.set(fn, [name]);
  }
  for (const kind of rule.types ?? []) {
    const names = FEATURES_BY_TYPE.get(kind);
    if (names) names.push(name);
    else FEATURES_BY_TYPE.set(kind, [name]);
  }
  for (const prefix of rule.prefixes ?? []) FEATURE_PREFIXES.push({ prefix, name });
  if (rule.libCall) FEATURE_LIBCALL_TESTS.push(name);
  if (rule.expr) FEATURE_EXPR_TESTS.push(name);
}

function scanRuntimeFeatures(
  mod: IrModule,
  stopAt?: RuntimeFeatureName,
  nodes?: IrNodeIndex,
): RuntimeFeatures {
  const features = noRuntimeFeatures();
  const scans: { name: RuntimeFeatureName; scan: RuleScan }[] = [];
  for (const name of RUNTIME_FEATURE_NAMES) {
    const { initial, scan } = ruleOf(name);
    if (initial && initial(mod)) features[name] = true;
    if (scan) scans.push({ name, scan: scan(mod) });
  }
  const keepGoing = (): boolean => stopAt === undefined || !features[stopAt];
  let tables: TypeTables | undefined;
  const typeTables = (): TypeTables =>
    (tables ??= {
      records: new Map((mod.records ?? []).map((r) => [r.id, r])),
      unions: new Map((mod.unions ?? []).map((u) => [u.id, u])),
      classes: new Map((mod.classes ?? []).map((c) => [c.name, c])),
    });
  const visit = (node: IrExpr): boolean => {
    for (let i = 0; i < scans.length; i++) scans[i]!.scan.expr(node);
    if (node.kind === "libCall") {
      const fn = node.fn;
      for (const name of FEATURES_BY_FN.get(fn) ?? []) features[name] = true;
      for (const { prefix, name } of FEATURE_PREFIXES)
        if (!features[name] && fn.startsWith(prefix)) features[name] = true;
      for (const name of FEATURE_LIBCALL_TESTS)
        if (!features[name] && ruleOf(name).libCall!(node)) features[name] = true;
    } else {
      for (const name of FEATURE_EXPR_TESTS)
        if (!features[name] && ruleOf(name).expr!(node, typeTables)) features[name] = true;
    }
    return keepGoing();
  };
  const expr = (node: IrExpr): boolean => {
    if (!visit(node)) return false;
    // A typed slot's adoption boxes the converted value as a live capsule
    // the module holds no `dynFrom` for: the rules read it as one.
    if (node.kind === "dynCheck" && node.shared === true)
      return visit(adoptionCapsule(node.type, node.loc));
    return true;
  };
  const type = (node: IrType): boolean => {
    for (const name of FEATURES_BY_TYPE.get(node.kind) ?? []) features[name] = true;
    return keepGoing();
  };
  // Each condition is a fact about one expression or one type (the rule
  // scans combine such facts in no particular order), so the index's
  // expressions and distinct types answer as the walk does. An early stop
  // (stopAt) keeps the walk.
  if (nodes !== undefined && stopAt === undefined) {
    const expressions = nodes.expressions();
    for (const fn of mod.functions)
      eachNodeOfKinds(fn, expressions, (node) => {
        expr(node as IrExpr);
      });
    for (const t of nodes.types) type(t);
  } else if (keepGoing()) everyModuleNode(mod, { expr, stmt: keepGoing, type });
  for (const { name, scan } of scans) if (scan.result()) features[name] = true;
  // Inline-cache sites of dynamic-tier functions use the tier's caches
  // (scr_js_object.c).
  if (!features.dynTier && mod.functions.some((fn) => fn.tier === "dynamic")) {
    const sites = new JsIcSites(mod);
    features.dynTier = mod.functions.some((fn) => fn.tier === "dynamic" && hasJsIcSite(fn, sites));
  }
  // A jsval parameter or result (ir/jsval.ts) is retained and released
  // through the tier's word reference counting, with or without a js.*
  // operation in the body.
  if (!features.dynTier)
    features.dynTier = mod.functions.some(
      (fn) => fn.returnType.kind === "jsval" || fn.params.some((p) => p.type.kind === "jsval"),
    );
  return features;
}

/** True when the module contains any regex construct — a regexLit /
 * regexIntrinsic node or a regex-typed slot anywhere. This is the link
 * switch that pulls scr_regex.c + the vendored libregexp into the binary
 * (native-toolchain.ts); regex-free programs keep the historical command line. The
 * typed traversal visits type slots as well as executable nodes. */
/** True when the module enters AsyncLocalStorage stores (RuntimeFeatures
 * asyncContext): a walk for those libCalls alone, without the other
 * features' rules. */
export function moduleUsesAsyncContext(mod: IrModule): boolean {
  const visitor = {
    expr: (e: IrExpr): boolean => e.kind !== "libCall" || !ASYNC_CONTEXT_LIB_FNS.has(e.fn),
    stmt: (): boolean => true,
  };
  return !mod.functions.every((fn) => everyStmtList(fn.body, visitor));
}

export function moduleUsesRegex(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "regex").regex;
}

/** True when the module contains an intrinsic whose implementation lives
 * in scr_copying.c. This is the link switch that keeps the optional
 * Array-copying and typed-array bridge TU out of unrelated binaries. */
export function moduleUsesCopying(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "copying").copying;
}

/** True when a non-UTF-8 TextDecoder call survives lowering. This gates the
 * generated legacy mapping tables inside scr_bytes.c; the default UTF-8
 * decoder and unrelated Buffer users keep their prior runtime object. */
export function moduleUsesLegacyTextDecoder(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "legacyTextDecoder").legacyTextDecoder;
}

/** True when a FileHandle type survives in the module. This is the link
 * switch for scr_file_handle.c; fs/promises.open carries the type inside its
 * promise result even when no handle method is called. */
export function moduleUsesFileHandle(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fileHandle").fileHandle;
}

/** True when native fetch operations survive lowering. This links
 * scr_fetch.c and its socket/tls/zlib dependencies and makes the emitted
 * main call scr_fetch_install. Fetch-free graphs keep their link lines. */
export function moduleUsesFetch(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fetch").fetch;
}

/** True when the module uses the process-events surface — the link switch
 * that pulls scr_events.c into the binary and has the emitted main call
 * scr_events_install (native-toolchain.ts + emitter; the scr_regex/scr_fetch/scr_zlib
 * gating precedent). Event-free programs pay zero bytes and keep their
 * exact link line. Same generic-walk shape as moduleUsesRegex. */
export function moduleUsesProcessEvents(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "processEvents").processEvents;
}

/** True when the module uses the node:events EventEmitter surface — the
 * link switch that pulls scr_events_emitter.c into the binary (native-toolchain.ts; the
 * scr_events.c gating precedent, but pure data structure: no install, no
 * loop hooks). Two signals: the `%EventEmitter` class def rides the
 * module (any emitter-typed value or `extends EventEmitter` subclass
 * references it, and the emitted RC/trace helpers call scr_emitter_*),
 * or an emitter.* libCall survived (the defaultMaxListeners statics carry
 * no emitter-typed value). Emitter-free programs pay zero bytes and keep
 * their exact link line. */
export function moduleUsesEmitter(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "emitter").emitter;
}

/** True when the program touches the node:stream surface (scr_stream.c —
 * the moduleUsesEmitter story: the class defs ride the module whenever a
 * stream-typed value exists, and every stream libCall names its unit).
 * Stream programs always use the emitter unit too — the stream class
 * defs pull `%EventEmitter` through their base chain, so
 * moduleUsesEmitter answers true whenever this does. Stream-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesStream(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "stream").stream;
}

/** True when the program links scr_dyn_builtin_stream.c (stream classes
 * as untyped constructor values): its runtime streams box through that
 * unit's view and checked casts to the stream classes accept constructor-
 * function streams. Programs without it keep their exact code. */
export function moduleUsesDynBuiltinStream(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynBuiltinStream").dynBuiltinStream;
}

export const NPM_COMPRESS_MIN = 1024;

export function moduleUsesZlib(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "zlib").zlib;
}

/** True when the module contains any dc.* libCall — the link switch that
 * pulls scr_dc.c (the diagnostics_channel registry and pub/sub) into the
 * binary (native-toolchain.ts). Channel-free binaries keep their exact size class.
 * Same walk shape as moduleUsesZlib. */
export function moduleUsesDc(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dc").dc;
}

/** True when the module contains any assert libCall — the link switch
 * that pulls scr_assert.c into the binary (native-toolchain.ts). scr_regex.c calls the
 * assert throw/inspect helpers (assert.match lives there), so the regex
 * switch also pulls scr_assert.c; assert-free, regex-free binaries keep
 * the historical command line and size. Same walk shape as
 * moduleUsesZlib. */
export function moduleUsesAssert(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "assert").assert;
}

/** True when the module contains any dynInvoke node or dyn.defineProps
 * libCall — the link switch that pulls scr_dyn_invoke.c (the prototype-
 * method dispatch on dyn receivers, plus scr_dyn_display and
 * scr_dyn_define_props) into the binary (native-toolchain.ts; the assert gating
 * precedent — dispatch-free binaries keep their exact size class). Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynInvoke(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynInvoke").dynInvoke;
}

/** True when the module contains any insp libCall — the link switch that
 * pulls scr_inspect.c into the binary (native-toolchain.ts; the assert gating
 * precedent — inspect-free binaries keep the historical command line and
 * size class). Same walk shape as moduleUsesZlib. */
/** True when the module needs scr_async_dyn.c — the checked-dynamic
 * async surfaces (dyn-promise then/catch/finally reactions, await of a
 * dyn value, `new Promise(setImmediate)`, AsyncLocalStorage, the
 * unhandledRejection/warning process events). Also pulled by the
 * dynInvoke and dc gates (their TUs call into this one) — native-toolchain.ts. Same
 * walk shape as moduleUsesZlib. */
export function moduleUsesDynAsync(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynAsync").dynAsync;
}

export function moduleUsesInspect(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "inspect").inspect;
}

/** True when the module reaches child_process or carries one of its runtime
 * handle/result types. Besides the existing link consequence, this gates the
 * checked-dynamic ChildProcess handle table installed from scr_child.c. */
export function moduleUsesChildProcess(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "childProcess").childProcess;
}

/** True when the module contains any net libCall — the link switch that
 * pulls scr_net.c into the binary and has the emitted main call
 * scr_net_install (native-toolchain.ts + emitter; the scr_events gating precedent).
 * Net-free programs pay zero bytes and keep their exact link line. Same
 * generic-walk shape as moduleUsesZlib. */
export function moduleUsesNet(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "net").net;
}

/** True when the module contains any sym.* libCall or a symbol-kind type
 * anywhere in the IR — the link switch that pulls scr_symbol.c into the
 * binary (native-toolchain.ts; the scr_net gating precedent — no install call, the
 * Symbol.for registry initializes lazily). The TYPE check matters like
 * net's: a symbol-typed local whose initializer compiled to a runtime
 * fence still emits release calls that need the unit linked. Symbol-free
 * programs pay zero bytes and keep their exact link line. */
export function moduleUsesSymbol(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "symbol").symbol;
}

/** True when bigint runtime operations or bigint-typed storage appears in
 * the IR. The type check keeps retain/release references link-safe even
 * when a producing statement was replaced by a runtime fence. */
export function moduleUsesBigInt(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "bigint").bigint;
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
  return scanRuntimeFeatures(mod, "searchParams").searchParams;
}

/** True when the module uses the node:querystring surface — the qs.*
 * libCalls that live in scr_qs.c (parse/stringify/unescape; qs.escape
 * emits the always-linked component encoder and deliberately does NOT
 * flip this switch) — the link switch that pulls scr_qs.c into the
 * binary (the moduleUsesSearchParams precedent: pure data transforms, no
 * loop hooks, cross-compiles everywhere). qs-free programs keep their
 * exact link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesQs(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "qs").qs;
}

export function moduleUsesParseArgs(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "parseArgs").parseArgs;
}

/** True when the module contains any fs.watch/watcher.* libCall — the
 * link switch that pulls scr_watch.c into the binary and has the emitted
 * main call scr_watch_install (native-toolchain.ts + emitter; the scr_net gating
 * precedent). Watch-free programs pay zero bytes and keep their exact
 * link line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesFsWatch(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fsWatch").fsWatch;
}

/** True when the module contains an fs.watchFile/fs.unwatchFile libCall —
 * the link switch that pulls scr_watch_file.c into the binary and has the
 * emitted main call scr_watch_file_install (the moduleUsesFsWatch
 * precedent, one unit of its own). Programs that never poll pay zero bytes
 * and keep their exact link line. */
export function moduleUsesFsWatchFile(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fsWatchFile").fsWatchFile;
}

/** True when the module contains any test.* libCall or a testCtx handle
 * type — the link switch that pulls scr_test.c into the binary and has
 * the emitted main return scr_test_exit_code() after the loop drains
 * (native-toolchain.ts + emitter; the moduleUsesDgram shape). Test-free programs pay
 * zero bytes and keep their exact link line. */
export function moduleUsesNodeTest(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "nodeTest").nodeTest;
}

/** True when the module calls a mock.timers member (a test.mockTimers* or
 * test.ctxMockTimers* libCall). The emitter then routes the timer calls
 * through scr_test.c's mock-aware entry points; other programs keep the
 * loop's timer functions. */
export function moduleUsesMockTimers(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "mockTimers").mockTimers;
}

/** True when the module contains any dgram.* or dns.* libCall — the
 * link switch that pulls scr_dgram.c into the binary and has the emitted
 * main call scr_dgram_install (native-toolchain.ts + emitter; the scr_net gating
 * precedent — dns.lookup lives in the same unit, so either prefix
 * answers). Dgram-free programs pay zero bytes and keep their exact link
 * line. Same generic-walk shape as moduleUsesZlib. */
export function moduleUsesDgram(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dgram").dgram;
}

/** True when the module contains any http.* libCall — the link switch
 * that pulls scr_http.c into the binary (native-toolchain.ts; moduleUsesNet already
 * answers true for these, so scr_net.c comes along). */
export function moduleUsesHttpServer(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "http").http;
}

/** True when the module uses the REAL h2 surface (scr_http2.c): any core
 * http2.* libCall, or an h2 handle type left behind by a fenced statement
 * (its emitted release call needs the unit — the moduleUsesNet story). */
export function moduleUsesHttp2(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "http2").http2;
}

/** True when the module contains any tls.* or https.* libCall — the link
 * switch that pulls scr_tls.c and the vendored mbedTLS archive into the
 * binary (native-toolchain.ts; moduleUsesNet and moduleUsesHttpServer already answer
 * true for these, so scr_net.c and scr_http.c come along). TLS-free
 * programs keep their exact link line and never build mbedTLS. */
export function moduleUsesTls(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "tls").tls;
}

/** True when the module contains any tlsca.* libCall — the link switch
 * for scr_tls_ca.c, the CA-store introspection unit (getCACertificates /
 * rootCertificates / setDefaultCACertificates). Deliberately SEPARATE
 * from moduleUsesTls: the unit is plain PEM-block bookkeeping, so a
 * program that only inspects the CA store never pulls mbedTLS. native-toolchain.ts
 * also compiles the unit whenever TLS itself links — scr_tls.c consults
 * the unit's default-set override for its trust anchors. */
export function moduleUsesTlsCa(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "tlsCa").tlsCa;
}

/** True when the module has dynamic-tier jsval operations or inline-cache
 * sites: the link switch for the scr_js_* runtime units (two-tier design
 * I3). Programs without them never link a scr_js_ symbol. */
export function moduleUsesDynTier(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "dynTier").dynTier;
}
