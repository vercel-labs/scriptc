/** Runtime requirements derived from the lowered program, shared by compiler hosts. */
import { type IrModule } from "../ir/ir.js";
import { jsObjectModelFact, moduleRuntimeFeatures } from "../ir/runtime-features.js";
import { hasForeignFfiCallback } from "./ffi-callbacks.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import { withRequiredLinkFeatures } from "./native-link-info-core.js";
import { youngNurseryRequested } from "./young-nursery.js";

/** Whether a build hands the program's sources to the emitter
 * (LlvmTargetOptions.debugSources): `--optimization dev` without
 * `--strip`. Such a build keeps positions in its stack frames and passes
 * each checked conversion's position to its failure path. */
export function carriesDebugSources(
  optimization: "release" | "dev" | "speed" | undefined,
  strip: boolean | undefined,
): boolean {
  return optimization === "dev" && strip !== true;
}

/** `debugSources`: the build carries debug sources (carriesDebugSources),
 * so its checked conversions call the report of their failures. */
export function executableLinkFeatures(
  mod: IrModule,
  largePages = false,
  debugSources = false,
): NativeLinkFeatures {
  const features = moduleRuntimeFeatures(mod);
  // A feature that calls into another feature's units links those too
  // (LINK_FEATURE_REQUIREMENTS), whichever fact selected it.
  return withRequiredLinkFeatures({
    ...(mod.workers ? { workers: true } : {}),
    ...(largePages ? { largePages: true } : {}),
    ...(debugSources && mod.lib === undefined ? { conversionTrace: true } : {}),
    ...(youngNurseryRequested() && mod.lib === undefined ? { youngNursery: true } : {}),
    regex: features.regex,
    copying: features.copying,
    textDecoderLegacy: features.legacyTextDecoder,
    bigintBytes: features.bigintBytes,
    fileHandle: features.fileHandle,
    fetch: features.fetch,
    ...(features.eventTarget ? { eventTarget: true } : {}),
    ...(features.wasm ? { wasm: true } : {}),
    ...(features.warningReplace ? { warningReplace: true } : {}),
    ...(features.promiseRejectDyn ? { promiseRejectDyn: true } : {}),
    ...(jsObjectModelFact(features) ? { jsObjectModel: true } : {}),
    mutableBuffers: features.mutableBuffers,
    ...(features.fsFlags ? { fsFlags: true } : {}),
    ...(features.fsExistsValue ? { fsExistsValue: true } : {}),
    ...(features.moduleCompileCache ? { moduleCompileCache: true } : {}),
    ...(features.fnMemberProps ? { fnMemberProps: true } : {}),
    ...(features.fsBytesWrites ? { fsBytesWrites: true } : {}),
    ...(features.strdecDyn ? { strdecDyn: true } : {}),
    ...(features.processExtras ? { processExtras: true } : {}),
    ...(features.streamWriteErrors ? { streamWriteErrors: true } : {}),
    ...(features.stdioObject ? { stdioObject: true } : {}),
    ...(features.ttyColors ? { ttyColors: true } : {}),
    ...(features.streamPipeEvents ? { streamPipeEvents: true } : {}),
    ...(features.fsStreamSignal ? { fsStreamSignal: true } : {}),
    ...(features.nodeIsland ? { nodeIsland: true } : {}),
    ...(features.moduleNamespace ? { moduleNamespace: true } : {}),
    ...(features.moduleNamespaceDyn ? { moduleNamespaceDyn: true } : {}),
    ...(features.primitiveWrapper ? { primitiveWrapper: true } : {}),
    ...(features.iteratorProto ? { iteratorProto: true } : {}),
    zlib: features.zlib,
    ...(features.brotli ? { brotli: true } : {}),
    ...(features.zstd ? { zstd: true } : {}),
    assert: features.assert,
    inspect: features.inspect,
    dynInvoke: features.dynInvoke,
    dc: features.dc,
    dynAsync: features.dynAsync,
    ...(features.promiseGeneric ? { promiseGeneric: true } : {}),
    ...(features.dynTier ? { dynTier: true } : {}),
    ...(features.streamDyn ? { streamDyn: true } : {}),
    ...(features.handleProps ? { handleProps: true } : {}),
    ...(features.childLifecycle ? { childLifecycle: true } : {}),
    ...(features.processFeatures ? { processFeatures: true } : {}),
    // A child process an island made, in a native ChildProcess slot
    // (scr_node_island_child.c): a program with both islands and child_process.
    ...(features.nodeIsland && features.childProcess ? { islandChild: true } : {}),
    ...(features.childOptionExt ? { childOptionExt: true } : {}),
    ...(features.spawnCaptureBytes ? { spawnCaptureBytes: true } : {}),
    ...(features.childErrorFields ? { childErrorFields: true } : {}),
    ...(features.childStreamFlow ? { childStreamFlow: true } : {}),
    ...(features.declAdopt ? { declAdopt: true } : {}),
    ...(features.typeOrigins ? { typeOrigins: true } : {}),
    ...(features.dynForAwait ? { dynForAwait: true } : {}),
    ...(features.dynCollections ? { dynCollections: true } : {}),
    ...(features.dynIntegrityQueries ? { dynIntegrityQueries: true } : {}),
    ...(features.reflectProtoTarget ? { reflectProtoTarget: true } : {}),
    ...(features.recordSourceDelete ? { recordSourceDelete: true } : {}),
    ...(features.recordViewFrozen ? { recordViewFrozen: true } : {}),
    ...(features.genBind ? { genBind: true } : {}),
    ...(features.genReceiver ? { genReceiver: true } : {}),
    ...(features.recordSourceGet ? { recordSourceGet: true } : {}),
    ...(features.eventsOnceSignal ? { eventsOnceSignal: true } : {}),
    ...(features.mime ? { mime: true } : {}),
    ...(features.webStreams ? { webStreams: true } : {}),
    ...(features.webBodies ? { webBodies: true } : {}),
    // A Node island can hand its own AbortSignal to any native receiver of
    // one, and a native signal then stands for it (scr_node_island_abort.c):
    // a program with islands and a receiver links the signal unit too.
    ...(features.abortSignal || (features.nodeIsland && features.eventTarget)
      ? { abortSignal: true }
      : {}),
    ...(features.utilTiming ? { utilTiming: true } : {}),
    ...(features.dynBuffer ? { dynBuffer: true } : {}),
    ...(features.fsPathValue ? { fsPathValue: true } : {}),
    ...(features.builtinValues ? { builtinValues: true } : {}),
    ...(features.stdlibPrototypeValue ? { stdlibPrototypeValue: true } : {}),
    ...(features.dataViewPrototypeValue ? { dataViewPrototypeValue: true } : {}),
    ...(features.hostAbsentGlobals ? { hostAbsentGlobals: true } : {}),
    ...(features.deferredFence ? { deferredFence: true } : {}),
    ...(features.functionOwnWrite ? { functionOwnWrite: true } : {}),
    ...(features.arrayLikeDispatch ? { arrayLikeDispatch: true } : {}),
    ...(features.builtinMethodValue ? { builtinMethodValue: true } : {}),
    ...(features.computedRequire ? { computedRequire: true } : {}),
    // Island code's signal and exit listeners join the events unit's
    // registries (scope-B NI-3).
    events: features.processEvents || features.nodeIsland === true,
    emitter: features.emitter,
    symbol: features.symbol,
    bigint: features.bigint,
    ...(features.bigstats ? { bigstats: true } : {}),
    searchParams: features.searchParams,
    qs: features.qs,
    utilPromisify: features.utilPromisify,
    dynBuiltinClass: features.dynBuiltinClass,
    dynBuiltinStream: features.dynBuiltinStream,
    parseArgs: features.parseArgs,
    stream: features.stream,
    net: features.net,
    http: features.http,
    http2: features.http2,
    dgram: features.dgram,
    dnsPromises: features.dnsPromises,
    dgramDyn: features.dgramDyn,
    textCodecDyn: features.textCodecDyn,
    watch: features.fsWatch,
    watchFile: features.fsWatchFile,
    foreignFfi: hasForeignFfiCallback(mod.ffiImports ?? []),
    nodeTest: features.nodeTest,
    tls: features.tls,
    tlsCa: features.tlsCa,
    cipher: features.cipher,
    ecdh: features.ecdh,
    dh: features.dh,
    pki: features.pki,
    ed25519: features.ed25519,
    x509: features.x509,
    webcrypto: features.webcrypto,
    perfLoop: features.perfLoop,
    ...(features.icu ? { intl: true } : {}),
  });
}
