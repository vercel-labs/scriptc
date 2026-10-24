import type { IrClassDef, IrExpr, IrModule, IrRecordShape, IrType, IrUnionDef } from "./ir.js";
import type { IrLibFn } from "./builtin-signatures.js";
import {
  isDirentShape,
  recordTextCodecClass,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  RUNTIME_STREAM_CLASSES,
} from "./ir.js";
import { everyModuleNode } from "./traverse.js";
import { eachNodeOfKinds, type IrNodeIndex } from "./node-index.js";
import { JsIcSites, hasJsIcSite } from "./js-ic.js";

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

/** Buffer.prototype members scr_bytes_dyn.c refuses on Buffer receivers. */
const DYN_BUFFER_REFUSED_METHODS: readonly string[] = [
  ...["read", "write"].flatMap((rw) => [
    ...["UIntLE", "UIntBE", "UintLE", "UintBE", "IntLE", "IntBE"].map((n) => `${rw}${n}`),
    ...["BigUInt64", "BigUint64", "BigInt64"].flatMap((n) => [`${rw}${n}LE`, `${rw}${n}BE`]),
  ]),
  ...["ascii", "base64", "base64url", "latin1", "hex", "ucs2", "utf8"].flatMap((enc) => [
    `${enc}Slice`,
    `${enc}Write`,
  ]),
  "inspect",
];

/** The scr_bytes_dyn.c entry, one per method family, that a checked-dynamic
 * call of a Buffer.prototype method name routes to: the fixed-width reads and
 * writes (both "UInt" and "Uint" spellings), write, fill, toString, the
 * searches, and the other Buffer-only members. Each runs the method on a
 * Buffer receiver and gives any other receiver the ordinary dispatch. */
export const DYN_BUFFER_METHODS: ReadonlyMap<string, string> = new Map([
  ...[...DYN_BUFFER_NUM_METHODS].map((m): [string, string] => [m, "scr_dyn_invoke_buffer_num"]),
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
    ...DYN_BUFFER_REFUSED_METHODS,
  ].map((m): [string, string] => [m, "scr_dyn_invoke_buffer"]),
]);

const DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  // DEP0040 rides the dyn-async unit's warning machinery.
  "async.awaitDyn",
  // The child property table adopts thenables through the dyn-async unit.
  "child.propsInstall",
  "child.propsResolve",
  "crypto.native",
  // The crypto global's object extends crypto.native's.
  "webcrypto.object",
  "dyn.promiseAll",
  "dyn.promiseAllSettled",
  "dyn.promiseAny",
  "dyn.promiseResolve",
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
  "process.onUnhandledRejection",
  "process.onWarning",
  "process.setDeprecationFlag",
  "process.setEmitWarning",
  "punycode.warn",
  // DEP0005 for the deprecated Buffer constructor.
  "buffer.deprecation",
  "timers.immediatePromise",
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
  "util.inherits",
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
  "url.legacyFormat",
  "url.legacyParse",
  "url.legacyResolve",
]);

const UTIL_CALLABLE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "util.callbackify",
  "util.debuglog",
  "util.deprecate",
  "util.inherits",
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
  "http.clientSignal",
  "http.requestDyn",
  "http.requestDynCb",
  "https.requestDyn",
  "https.requestDynCb",
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
  "fileHandle.createWriteStream",
  "fs.createReadStream",
  "fs.createWriteStream",
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
  "stream.pipeDyn",
  "stream.prop",
  "stream.stdioWritable",
  "stream.unboxDyn",
  "stream.handleStream",
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
]);

/** libCall name prefixes of the Readable entry points that await through the dyn-async unit. */
const READABLE_DYN_ASYNC_PREFIXES: readonly string[] = ["readable.fromGen", "readable.op"];

/** Entry points that link the dyn-invoke unit. */
const DYN_INVOKE_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "dyn.arrayProtoCall",
  "dyn.arrayPrototype",
  "dyn.builtinFunction",
  "dyn.builtinMethod",
  "dyn.defineProperty",
  "child.propsDefine",
  "dyn.defineProps",
  "dyn.definePrototypeProps",
  "dyn.functionApply",
  "dyn.globalConstructor",
  "dyn.objCreateWithProperties",
  "dyn.objectTag",
  "stream.dynNative",
  "stream.dynNativePipe",
  "stream.pipeDyn",
  "stream.unpipeDyn",
]);

/** Member names whose constant-key dynamic reads answer the inherited Object.prototype member through scr_dyn_inherited.c. Mirrors expr-dynamic.ts INHERITED_OBJECT_MEMBERS (the IR layer does not import the backend). */
const INHERITED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
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
  // EventEmitter's kShapeMode and kCapture properties
  ...BUILTIN_CLASS_LIB_FNS,
  "dyn.usingDispose",
  "dyn.usingMethod",
  "util.isDeepStrictEqual",
  // The Buffer function value's Symbol(kIsEncodingSymbol) member
  "buffer.constructor",
  "buffer.staticValue",
  "buffer.prototypeMember",
]);

/** Entry points that link the querystring unit. */
const QS_LIB_FNS: ReadonlySet<IrLibFn> = new Set(["qs.parse", "qs.stringify", "qs.unescape"]);

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
  /** mentionsTextCodec's and mentionsTextDecoder's carriers. */
  textCodecCarriers?: TypeCarriers;
  textDecoderCarriers?: TypeCarriers;
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

const textCodecLeaf: CarrierLeaf = (t, tables) => {
  if (t.kind !== "record") return false;
  const shape = tables.records.get(t.shapeId);
  return shape !== undefined && recordTextCodecClass(shape) !== null;
};

const textDecoderLeaf: CarrierLeaf = (t, tables) => {
  if (t.kind !== "record") return false;
  const shape = tables.records.get(t.shapeId);
  return shape !== undefined && recordTextCodecClass(shape) === "TextDecoder";
};

/** Whether converting a value of type `t` to or from dyn converts a
 * TextEncoder or TextDecoder record, which boxes it as a handle of
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
  "process.stdio",
  "stdin.nextChunk",
  "stdin.onData",
  "stdin.onEnd",
  "stdin.onError",
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

/** Names that reach the extended process-stream surface (the
 * SCR_STDIO_EXTENDED events unit): stdin.setEncoding and 'resize'. */
const STDIO_EXTENDED_NAMES: ReadonlySet<string> = new Set(["setEncoding", "resize"]);

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
  scan?: () => RuleScan;
  fns?: readonly IrLibFn[];
  prefixes?: readonly string[];
  libCall?: (node: LibCallNode) => boolean;
  expr?: (node: IrExpr, tables: () => TypeTables) => boolean;
  types?: readonly IrType["kind"][];
}

/** Gives every rule in the table one type. */
const rule = (r: RuntimeFeatureRule): RuntimeFeatureRule => r;

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
  /** scr_wasm.c converts i64 values through BigInt. */
  bigint: rule({
    fns: ["process.hrtimeValue"],
    prefixes: ["bigint.", "wasm."],
    types: ["bigint"],
  }),
  childProcess: rule({
    fns: [...CHILD_PROCESS_LIB_FNS],
    prefixes: CHILD_PROCESS_LIB_PREFIXES,
    types: ["child", "childStream", "childWriter", "spawnRes"],
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
  /** A TextEncoder or TextDecoder record converts to or from an untyped
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
    // The legacy url functions, crypto.createCipheriv and
    // ecdh.setPublicKey emit their deprecation warnings through the
    // dyn-async unit (WebCrypto's encrypt and decrypt link scr_cipher.c
    // too); scr_wasm.c boxes its handles and promises through it.
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
    ],
    prefixes: [...READABLE_DYN_ASYNC_PREFIXES, "wasm."],
    expr: (node, tables) =>
      (node.kind === "awaitExpr" && node.type.kind === "dyn") ||
      // Rejection reasons cross as dyn values (allSettled's records, any's
      // AggregateError list).
      (node.kind === "intrinsic" &&
        (node.name === "promise.allSettled" || node.name === "promise.any")) ||
      (node.kind === "dynFrom" && boxesPromise(node.value.type, tables(), new Set())),
  }),
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
  dynInvoke: rule({
    initial: (mod) => mod.workers === true,
    fns: [
      ...DYN_INVOKE_LIB_FNS,
      ...UTIL_CALLABLE_LIB_FNS,
      ...BUILTIN_CLASS_LIB_FNS,
      "util.promisifyDyn",
      "buffer.prototypeMember",
    ],
    expr: (node, _tables) => node.kind === "dynInvoke",
  }),
  /** Dynamic reads whose key may name an Object.prototype member: constant
   * keys naming one, and every computed key (built at run time, so it may
   * name one). An undefined read answers the inherited member through
   * scr_dyn_inherited.c, which references only the base units. */
  dynInherited: rule({
    expr: (node, _tables) =>
      node.kind === "dynKeyGet" &&
      (node.key.kind !== "strLit" || INHERITED_MEMBER_NAMES.has(node.key.value)),
  }),
  /** `new` through the builtin constructors those reads answer
   * (scr_dyn_global_construct.c), installed at start by programs that also
   * construct dynamic values. */
  dynGlobalConstruct: rule({ fns: ["dyn.globalConstructInstall"] }),
  /** The program has dynamic-tier jsval operations (js.* builtins, the
   * jsval pass): links the scr_js_* units (two-tier design I3). */
  dynTier: rule({ prefixes: ["js."] }),
  /** Checked-dynamic stream slots test values and pipe into JavaScript
   * stream objects (scr_stream_dyn.c). */
  streamDyn: rule({
    fns: ["stream.dynNative", "stream.dynNativePipe", "stream.pipeDyn", "stream.unpipeDyn"],
  }),
  /** Own properties JavaScript adds to children (scr_dyn_handle_props.c). */
  handleProps: rule({ fns: ["child.propsInstall"] }),
  /** The declaration-typed boundary's adoption (scr_decl_adopt.c): its
   * casts, and closures boxed in a boundary program, which adopt their
   * arguments. */
  declAdopt: rule({ fns: ["dyn.declAdopt"], initial: (mod) => mod.declBoundary === true }),
  /** for await over checked-dynamic values (scr_dyn_for_await.c). */
  dynForAwait: rule({ fns: ["dyn.asyncIteratorOpen", "dyn.asyncIteratorWasSync"] }),
  /** Buffer.prototype methods called on checked-dynamic values
   * (scr_bytes_dyn.c). */
  dynBuffer: rule({
    // Buffer.prototype members read as values dispatch to the same entries.
    fns: ["buffer.prototypeMember"],
    expr: (node, _tables) => node.kind === "dynInvoke" && DYN_BUFFER_METHODS.has(node.method),
  }),
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
    fns: ["events.addAbortListener", ...ABORT_SIGNAL_LIB_FNS],
    prefixes: ["event."],
  }),
  /** events.once(emitter, name, { signal }) (scr_events_once_signal.c). */
  eventsOnceSignal: rule({ fns: ["events.onceSignal"] }),
  fetch: rule({ prefixes: ["fetch."] }),
  fileHandle: rule({ types: ["fileHandle"] }),
  fsWatch: rule({ prefixes: ["fs.watch", "watcher."], types: ["fsWatcher"] }),
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
  /** scr_test.c renders thrown strings with the inspect unit's string
   * formatting; scr_util_callable.c wraps the inspect unit; readline's
   * terminal unit prints completion errors through it when there is a
   * completer. */
  inspect: rule({
    fns: [
      "global.native",
      "util.styleText",
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
  legacyTextDecoder: rule({
    fns: [...LEGACY_TEXT_DECODER_LIB_FNS],
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
  /** scr_url_legacy.c lowercases and normalizes hostnames with the regex
   * unit's libunicode, NODE_DEBUG matching in scr_util_callable.c and
   * readline's terminal unit use the regex unit, and locale case mapping
   * runs its default conversion. */
  regex: rule({
    fns: [
      ...REGEX_LIB_FNS,
      ...LEGACY_URL_LIB_FNS,
      ...UTIL_CALLABLE_LIB_FNS,
      "rl.terminal",
      "str.localeCase",
    ],
    expr: (node, _tables) =>
      node.kind === "regexLit" ||
      node.kind === "regexIntrinsic" ||
      (node.kind === "strIntrinsic" && CASE_MAPPING_STR_METHODS.has(node.method)),
    types: ["regex"],
  }),
  searchParams: rule({ fns: ["url.searchParams"], prefixes: ["sp."], types: ["searchParams"] }),
  /** stdin setEncoding / string data listeners / stdio 'resize' events. A
   * typed string 'data' listener takes setEncoding-decoded chunks; the
   * process stream object's setEncoding and 'resize' members are reached
   * by name (dynamic member calls and event-name strings). */
  stdioExtended: rule({
    libCall: (node) =>
      node.fn === "stdin.onData" &&
      node.args[0]?.type.kind === "func" &&
      node.args[0].type.params[0]?.kind === "string",
    expr: (node, _tables) =>
      (node.kind === "dynInvoke" && STDIO_EXTENDED_NAMES.has(node.method)) ||
      (node.kind === "strLit" && STDIO_EXTENDED_NAMES.has(node.value)),
  }),
  stream: rule({
    initial: (mod) => (mod.classes ?? []).some((c) => RUNTIME_STREAM_CLASSES.has(c.name)),
    fns: [...STREAM_LIB_FNS, "dyn.builtinStreamClass"],
    prefixes: STREAM_LIB_PREFIXES,
  }),
  /** A Dirent row converted to dyn carries Node's Symbol(type) key
   * (scr_dyn_dirent_finish, defined in scr_symbol.c). */
  symbol: rule({
    initial: (mod) => (mod.records ?? []).some(isDirentShape),
    fns: [...SYMBOL_LIB_FNS],
    prefixes: ["sym.", "disposable."],
    types: ["symbol"],
  }),
  tls: rule({ prefixes: ["tls.", "https.", "http2."], types: ["secureCtx"] }),
  tlsCa: rule({ prefixes: ["tlsca."] }),
  /** util.promisify over an untyped function (scr_util_promisify.c): its
   * promises go through the dyn-async unit and its calls through the
   * dyn-invoke unit. */
  utilPromisify: rule({ fns: ["util.promisifyDyn"] }),
  /** process.emitWarning is assigned (process.setEmitWarning). */
  warningReplace: rule({ fns: ["process.setEmitWarning"] }),
  /** The WebAssembly API (scr_wasm.c). */
  wasm: rule({ prefixes: ["wasm."] }),
  /** crypto.subtle importKey/sign/verify/digest and CryptoKey:
   * scr_webcrypto.c. */
  webcrypto: rule({ prefixes: ["webcrypto."] }),
  zlib: rule({ prefixes: ["zlib."] }),
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
    childProcess: false,
    cipher: false,
    copying: false,
    dc: false,
    dgram: false,
    dgramDyn: false,
    textCodecDyn: false,
    dnsPromises: false,
    dynAsync: false,
    dynBuiltinClass: false,
    dynBuiltinStream: false,
    dynInvoke: false,
    dynInherited: false,
    dynGlobalConstruct: false,
    dynTier: false,
    ecdh: false,
    dh: false,
    emitter: false,
    eventTarget: false,
    eventsOnceSignal: false,
    fetch: false,
    fileHandle: false,
    fsWatch: false,
    http2: false,
    http: false,
    inspect: false,
    legacyTextDecoder: false,
    mockTimers: false,
    net: false,
    netLookup: false,
    nodeTest: false,
    parseArgs: false,
    perfLoop: false,
    pki: false,
    ed25519: false,
    processEvents: false,
    qs: false,
    regex: false,
    searchParams: false,
    stdioExtended: false,
    stream: false,
    streamDyn: false,
    handleProps: false,
    declAdopt: false,
    dynForAwait: false,
    dynBuffer: false,
    builtinValues: false,
    symbol: false,
    tls: false,
    tlsCa: false,
    utilPromisify: false,
    warningReplace: false,
    wasm: false,
    webcrypto: false,
    zlib: false,
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
    if (scan) scans.push({ name, scan: scan() });
  }
  const keepGoing = (): boolean => stopAt === undefined || !features[stopAt];
  let tables: TypeTables | undefined;
  const typeTables = (): TypeTables =>
    (tables ??= {
      records: new Map((mod.records ?? []).map((r) => [r.id, r])),
      unions: new Map((mod.unions ?? []).map((u) => [u.id, u])),
      classes: new Map((mod.classes ?? []).map((c) => [c.name, c])),
    });
  const expr = (node: IrExpr): boolean => {
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
  // Inline-cache sites of dynamic-tier functions use the tier's shapes
  // (scr_js_object.c, with the SCR_JS_TIER build of scr_json.c).
  if (!features.dynTier && mod.functions.some((fn) => fn.tier === "dynamic")) {
    const sites = new JsIcSites(mod);
    features.dynTier = mod.functions.some((fn) => fn.tier === "dynamic" && hasJsIcSite(fn, sites));
  }
  return features;
}

/** True when the module contains any regex construct — a regexLit /
 * regexIntrinsic node or a regex-typed slot anywhere. This is the link
 * switch that pulls scr_regex.c + the vendored libregexp into the binary
 * (native-toolchain.ts); regex-free programs keep the historical command line. The
 * typed traversal visits type slots as well as executable nodes. */
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
