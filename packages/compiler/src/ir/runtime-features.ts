import type { IrExpr, IrModule, IrType } from "./ir.js";
import type { IrLibFn } from "./builtin-signatures.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_STREAM_CLASSES } from "./ir.js";
import { everyModuleNode } from "./traverse.js";

export interface RuntimeFeatures {
  regex: boolean;
  copying: boolean;
  legacyTextDecoder: boolean;
  fileHandle: boolean;
  fetch: boolean;
  processEvents: boolean;
  emitter: boolean;
  stream: boolean;
  zlib: boolean;
  dc: boolean;
  assert: boolean;
  dynInvoke: boolean;
  dynAsync: boolean;
  inspect: boolean;
  childProcess: boolean;
  net: boolean;
  symbol: boolean;
  bigint: boolean;
  searchParams: boolean;
  qs: boolean;
  parseArgs: boolean;
  fsWatch: boolean;
  nodeTest: boolean;
  dgram: boolean;
  http: boolean;
  http2: boolean;
  tls: boolean;
  tlsCa: boolean;
}

const DYN_ASYNC_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "fs.callbackValue",
  "fs.callbackCall",
  "async.awaitDyn",
  "timers.immediatePromise",
  "crypto.native",
  "dyn.promiseAll",
  "process.onUncaughtException",
  "process.offUncaughtException",
  "process.onUnhandledRejection",
  "process.offUnhandledRejection",
  "process.onRejectionHandled",
  "process.offRejectionHandled",
  "process.onWarning",
  "process.offWarning",
  "process.emitWarning",
  "util.styleText",
  "als.new",
  "als.get",
  "als.run",
  "als.exitRun",
  "als.enterWith",
  "als.disable",
  "dc.chanBindStore",
  "dc.chanUnbindStore",
  "dc.chanRunStores",
]);

/** Inspect types and expressions together in one traversal. This is a fresh
 * snapshot: callers may mutate an IR module between compilation passes. */
export function moduleRuntimeFeatures(mod: IrModule): RuntimeFeatures {
  return scanRuntimeFeatures(mod);
}

function scanRuntimeFeatures(mod: IrModule, stopAt?: keyof RuntimeFeatures): RuntimeFeatures {
  const features: RuntimeFeatures = {
    regex: false,
    copying: false,
    legacyTextDecoder: false,
    fileHandle: false,
    fetch: mod.embedded?.modules.some((m) => m.usesFetch === true) ?? false,
    processEvents: false,
    emitter:
      mod.workers === true || (mod.classes ?? []).some((c) => c.name === RUNTIME_EMITTER_CLASS),
    stream: (mod.classes ?? []).some((c) => RUNTIME_STREAM_CLASSES.has(c.name)),
    zlib: mod.embedded?.edges.some((e) => e.to === "node:zlib") ?? false,
    dc: false,
    assert: false,
    dynInvoke: mod.workers === true,
    dynAsync:
      mod.workers === true ||
      mod.functions.some(
        (fn) => fn.async === true && fn.generator === undefined && fn.returnType.kind === "dyn",
      ),
    inspect: false,
    childProcess: false,
    net: false,
    symbol: false,
    bigint: false,
    searchParams: false,
    qs: false,
    parseArgs: false,
    fsWatch: false,
    nodeTest: false,
    dgram: false,
    http: false,
    http2: false,
    tls: false,
    tlsCa: false,
  };
  const keepGoing = (): boolean => stopAt === undefined || !features[stopAt];
  const expr = (node: IrExpr): boolean => {
    if (node.kind === "libCall") {
      const fn = node.fn;
      if (
        fn === "regexp.escape" ||
        fn === "dyn.nativeRegexIs" ||
        fn === "util.stripVTControlCharacters"
      )
        features.regex = true;
      if (
        fn === "text.decodeLegacy" ||
        fn === "text.decodeLegacyOptions" ||
        fn === "text.decodeStream"
      )
        features.legacyTextDecoder = true;
      if (fn.startsWith("fetch.")) features.fetch = true;
      if (PROCESS_EVENT_LIB_FNS.has(fn)) features.processEvents = true;
      if (fn.startsWith("emitter.")) features.emitter = true;
      if (
        fn.startsWith("readable.") ||
        fn.startsWith("writable.") ||
        fn.startsWith("duplex.") ||
        fn.startsWith("transform.") ||
        fn.startsWith("passthrough.") ||
        fn.startsWith("sc.") ||
        fn.startsWith("stream.set") ||
        fn === "stream.destroy" ||
        fn === "stream.destroyErr" ||
        fn === "stream.prop" ||
        fn === "stream.errored" ||
        fn === "sp.finished" ||
        fn === "sp.pipeline"
      )
        features.stream = true;
      if (fn.startsWith("zlib.")) features.zlib = true;
      if (fn.startsWith("dc.")) features.dc = true;
      if (fn.startsWith("assert.")) features.assert = true;
      if (
        fn === "dyn.defineProps" ||
        fn === "dyn.definePrototypeProps" ||
        fn === "dyn.defineProperty" ||
        fn === "dyn.objCreateWithProperties" ||
        fn === "dyn.arrayProtoCall" ||
        fn === "dyn.arrayPrototype" ||
        fn === "dyn.functionApply" ||
        fn === "dyn.builtinMethod"
      )
        features.dynInvoke = true;
      if (DYN_ASYNC_LIB_FNS.has(fn)) features.dynAsync = true;
      if (
        fn.startsWith("insp.") ||
        fn === "console.native" ||
        fn === "global.native" ||
        fn === "util.styleText"
      )
        features.inspect = true;
      if (
        fn.startsWith("cp.") ||
        fn.startsWith("child.") ||
        fn.startsWith("writer.") ||
        fn.startsWith("spawnRes.") ||
        fn === "process.forkTarget" ||
        fn === "process.connected" ||
        fn === "process.send" ||
        fn === "process.sendCb" ||
        fn === "process.disconnect" ||
        fn === "process.onMessage" ||
        fn === "process.onDisconnect"
      )
        features.childProcess = true;
      if (fn.startsWith("net.")) features.net = true;
      if (fn.startsWith("http.")) {
        features.net = true;
        features.http = true;
      }
      if (fn.startsWith("tls.") || fn.startsWith("https.") || fn.startsWith("http2.")) {
        features.net = true;
        features.http = true;
        features.tls = true;
      }
      if (fn.startsWith("http2.") && !HTTP2_LEGACY_FNS.has(fn)) features.http2 = true;
      if (fn.startsWith("sym.") || fn === "util.isDeepStrictEqual") features.symbol = true;
      if (fn === "process.hrtimeValue") features.bigint = true;
      if (fn.startsWith("bigint.")) features.bigint = true;
      if (fn.startsWith("sp.") || fn === "url.searchParams") features.searchParams = true;
      if (fn === "qs.parse" || fn === "qs.stringify" || fn === "qs.unescape") features.qs = true;
      if (fn === "util.parseArgs" || fn === "util.isDeepStrictEqual" || fn === "util.styleText")
        features.parseArgs = true;
      if (fn === "util.styleText") features.processEvents = true;
      if (fn.startsWith("fs.watch") || fn.startsWith("watcher.")) features.fsWatch = true;
      if (fn.startsWith("test.")) features.nodeTest = true;
      if (fn.startsWith("dgram.") || fn.startsWith("dns.")) features.dgram = true;
      if (fn.startsWith("tlsca.")) features.tlsCa = true;
    } else {
      switch (node.kind) {
        case "regexLit":
        case "regexIntrinsic":
          features.regex = true;
          break;
        case "strIntrinsic":
          if (
            node.method === "toLowerCase" ||
            node.method === "toUpperCase" ||
            node.method === "normalize"
          )
            features.regex = true;
          break;
        case "arrIntrinsic":
          if (
            node.method === "toReversed" ||
            node.method === "toSpliced" ||
            node.method === "with" ||
            node.method === "withUndefined"
          )
            features.copying = true;
          break;
        case "bytesIntrinsic":
          if (
            node.method === "toReversed" ||
            node.method === "with" ||
            node.method === "join" ||
            node.method === "toArray"
          )
            features.copying = true;
          break;
        case "jsOp":
          if (node.op === "globalGet" && node.name === "fetch") features.fetch = true;
          break;
        case "dynInvoke":
          features.dynInvoke = true;
          break;
        case "awaitExpr":
          if (node.type.kind === "dyn") features.dynAsync = true;
          break;
        case "dynFrom": {
          const boxed = node.value.type;
          if (boxed.kind === "promise" || (boxed.kind === "func" && boxed.ret.kind === "promise"))
            features.dynAsync = true;
          break;
        }
      }
    }
    return keepGoing();
  };
  const type = (node: IrType): boolean => {
    switch (node.kind) {
      case "regex":
        features.regex = true;
        break;
      case "fileHandle":
        features.fileHandle = true;
        break;
      case "procStream":
        features.processEvents = true;
        break;
      case "child":
      case "childStream":
      case "childWriter":
      case "spawnRes":
        features.childProcess = true;
        break;
      case "netServer":
      case "netSocket":
        features.net = true;
        break;
      case "http2Session":
      case "http2Stream":
        features.net = true;
        features.http2 = true;
        break;
      case "httpReq":
      case "httpRes":
      case "httpClientReq":
        features.net = true;
        features.http = true;
        break;
      case "secureCtx":
        features.net = true;
        features.http = true;
        features.tls = true;
        break;
      case "symbol":
        features.symbol = true;
        break;
      case "bigint":
        features.bigint = true;
        break;
      case "searchParams":
        features.searchParams = true;
        break;
      case "fsWatcher":
        features.fsWatch = true;
        break;
      case "testCtx":
        features.nodeTest = true;
        break;
      case "dgramSocket":
        features.dgram = true;
        break;
    }
    return keepGoing();
  };
  if (keepGoing()) everyModuleNode(mod, { expr, stmt: keepGoing, type });
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

/** True when user code lowers static fetch or the embedded npm graph
 * reaches the engine's global fetch — the link switch that pulls scr_fetch.c +
 * its socket/tls/zlib dependencies into the binary (native-toolchain.ts) and has the
 * emitted main call scr_fetch_install. The npm graph records the embedded
 * source fact with a parser + binder, so comments, strings, property names,
 * and local `fetch` bindings do not change the link or target capability.
 * Fetch-free graphs keep their exact historical link lines. */
export function moduleUsesFetch(mod: IrModule): boolean {
  return scanRuntimeFeatures(mod, "fetch").fetch;
}

/** The libCall fns served by the OPTIONAL events unit (scr_events.c):
 * process signal/exit listeners and the piped-stdin surface. */
const PROCESS_EVENT_LIB_FNS: ReadonlySet<IrLibFn> = new Set([
  "process.stdio",
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

/** True when the embedded npm graph has an edge into `builtin` — the
 * island shim needs the corresponding native bridge linked (zlib's is
 * the first; the emitted main installs it before any island entry). */
export function moduleEmbedsBuiltin(mod: IrModule, builtin: string): boolean {
  return mod.embedded !== undefined && mod.embedded.edges.some((e) => e.to === builtin);
}

/** Embedded module texts at least this long are DEFLATE-compressed into
 * the emitted LLVM (island.ts; each stays plain when deflate does not
 * shrink it) and inflated lazily by the island's module loader at first
 * load. Below it the zlib round trip cannot pay for itself. */
export const NPM_COMPRESS_MIN = 1024;

/** True when the emitted npm tables will carry compressed module text —
 * the SAME candidate test island.ts compresses by, so index.ts's
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
 * (native-toolchain.ts); zlib-free programs keep their exact link line. Same
 * generic-walk shape as moduleUsesRegex: `kind`/`fn` discriminants live
 * only on IR objects. */
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

/** True when the module uses native util parsing, comparison, or styling.
 * The utility units also follow their required symbol, inspection, and
 * warning features, independently of the island's node:util shim. */
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

/** The legacy http2.* libCalls implemented by scr_http.c/scr_tls.c (the
 * allowHTTP1 compatibility slice) — they must NOT pull scr_http2.c, so
 * divergence-57 binaries keep their exact link line. */
const HTTP2_LEGACY_FNS: ReadonlySet<IrLibFn> = new Set([
  "http2.streamNoop",
  "http2.streamUndefCall",
]);

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
