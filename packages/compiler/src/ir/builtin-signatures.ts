import { abortSignatures } from "./builtin-signatures/abort.js";
import { ahSignatures } from "./builtin-signatures/ah.js";
import { alsSignatures } from "./builtin-signatures/als.js";
import { arSignatures } from "./builtin-signatures/ar.js";
import { arraySignatures } from "./builtin-signatures/array.js";
import { arrayBufferSignatures } from "./builtin-signatures/arrayBuffer.js";
import { assertSignatures } from "./builtin-signatures/assert.js";
import { asyncSignatures } from "./builtin-signatures/async.js";
import { atomicsSignatures } from "./builtin-signatures/atomics.js";
import { bigintSignatures } from "./builtin-signatures/bigint.js";
import { bigstatsSignatures } from "./builtin-signatures/bigstats.js";
import { blobSignatures } from "./builtin-signatures/blob.js";
import { bufferSignatures } from "./builtin-signatures/buffer.js";
import { bytesSignatures } from "./builtin-signatures/bytes.js";
import { childSignatures } from "./builtin-signatures/child.js";
import { classSignatures } from "./builtin-signatures/class.js";
import { closureSignatures } from "./builtin-signatures/closure.js";
import { clusterSignatures } from "./builtin-signatures/cluster.js";
import { collectionSignatures } from "./builtin-signatures/collection.js";
import { consoleSignatures } from "./builtin-signatures/console.js";
import { constantsSignatures } from "./builtin-signatures/constants.js";
import { cpSignatures } from "./builtin-signatures/cp.js";
import { cryptoSignatures } from "./builtin-signatures/crypto.js";
import { dateSignatures } from "./builtin-signatures/date.js";
import { dcSignatures } from "./builtin-signatures/dc.js";
import { dgramSignatures } from "./builtin-signatures/dgram.js";
import { dirSignatures } from "./builtin-signatures/dir.js";
import { disposableSignatures } from "./builtin-signatures/disposable.js";
import { dnsSignatures } from "./builtin-signatures/dns.js";
import { duplexSignatures } from "./builtin-signatures/duplex.js";
import { dynSignatures } from "./builtin-signatures/dyn.js";
import { emitterSignatures } from "./builtin-signatures/emitter.js";
import { errorSignatures } from "./builtin-signatures/error.js";
import { eventSignatures } from "./builtin-signatures/event.js";
import { eventsSignatures } from "./builtin-signatures/events.js";
import { fetchSignatures } from "./builtin-signatures/fetch.js";
import { ffiSignatures } from "./builtin-signatures/ffi.js";
import { fileHandleSignatures } from "./builtin-signatures/fileHandle.js";
import { finalizationRegistrySignatures } from "./builtin-signatures/finalizationRegistry.js";
import { fsSignatures } from "./builtin-signatures/fs.js";
import { fspSignatures } from "./builtin-signatures/fsp.js";
import { globalSignatures } from "./builtin-signatures/global.js";
import { handleSignatures } from "./builtin-signatures/handle.js";
import { httpSignatures } from "./builtin-signatures/http.js";
import { http2Signatures } from "./builtin-signatures/http2.js";
import { httpsSignatures } from "./builtin-signatures/https.js";
import { icuSignatures } from "./builtin-signatures/icu.js";
import { inspSignatures } from "./builtin-signatures/insp.js";
import { intlSignatures } from "./builtin-signatures/intl.js";
import { iteratorSignatures } from "./builtin-signatures/iterator.js";
import { jsSignatures } from "./builtin-signatures/js.js";
import { jsonSignatures } from "./builtin-signatures/json.js";
import { mathSignatures } from "./builtin-signatures/math.js";
import { mimeSignatures } from "./builtin-signatures/mime.js";
import { mkdtempResultSignatures } from "./builtin-signatures/mkdtempResult.js";
import { moduleSignatures } from "./builtin-signatures/module.js";
import { navigatorSignatures } from "./builtin-signatures/navigator.js";
import { netSignatures } from "./builtin-signatures/net.js";
import { nodeIslandSignatures } from "./builtin-signatures/nodeIsland.js";
import { numSignatures } from "./builtin-signatures/num.js";
import { numberSignatures } from "./builtin-signatures/number.js";
import { osSignatures } from "./builtin-signatures/os.js";
import { passthroughSignatures } from "./builtin-signatures/passthrough.js";
import { pathSignatures } from "./builtin-signatures/path.js";
import { perfSignatures } from "./builtin-signatures/perf.js";
import { procStreamSignatures } from "./builtin-signatures/procStream.js";
import { processSignatures } from "./builtin-signatures/process.js";
import { promiseSignatures } from "./builtin-signatures/promise.js";
import { punycodeSignatures } from "./builtin-signatures/punycode.js";
import { qsSignatures } from "./builtin-signatures/qs.js";
import { readableSignatures } from "./builtin-signatures/readable.js";
import { recordSignatures } from "./builtin-signatures/record.js";
import { regexSignatures } from "./builtin-signatures/regex.js";
import { regexpSignatures } from "./builtin-signatures/regexp.js";
import { rlSignatures } from "./builtin-signatures/rl.js";
import { scSignatures } from "./builtin-signatures/sc.js";
import { seaSignatures } from "./builtin-signatures/sea.js";
import { sharedArrayBufferSignatures } from "./builtin-signatures/sharedArrayBuffer.js";
import { sourceMapSignatures } from "./builtin-signatures/sourceMap.js";
import { spSignatures } from "./builtin-signatures/sp.js";
import { spawnResSignatures } from "./builtin-signatures/spawnRes.js";
import { sqliteSignatures } from "./builtin-signatures/sqlite.js";
import { statWatcherSignatures } from "./builtin-signatures/statWatcher.js";
import { statsSignatures } from "./builtin-signatures/stats.js";
import { stdinSignatures } from "./builtin-signatures/stdin.js";
import { strSignatures } from "./builtin-signatures/str.js";
import { strdecSignatures } from "./builtin-signatures/strdec.js";
import { streamSignatures } from "./builtin-signatures/stream.js";
import { stringSignatures } from "./builtin-signatures/string.js";
import { symSignatures } from "./builtin-signatures/sym.js";
import { teSignatures } from "./builtin-signatures/te.js";
import { testSignatures } from "./builtin-signatures/test.js";
import { textSignatures } from "./builtin-signatures/text.js";
import { timersSignatures } from "./builtin-signatures/timers.js";
import { tlsSignatures } from "./builtin-signatures/tls.js";
import { tlscaSignatures } from "./builtin-signatures/tlsca.js";
import { tpSignatures } from "./builtin-signatures/tp.js";
import { transformSignatures } from "./builtin-signatures/transform.js";
import { urlSignatures } from "./builtin-signatures/url.js";
import { urlpatternSignatures } from "./builtin-signatures/urlpattern.js";
import { utilSignatures } from "./builtin-signatures/util.js";
import { wasmSignatures } from "./builtin-signatures/wasm.js";
import { watchEventsSignatures } from "./builtin-signatures/watchEvents.js";
import { watcherSignatures } from "./builtin-signatures/watcher.js";
import { weakMapSignatures } from "./builtin-signatures/weakMap.js";
import { weakRefSignatures } from "./builtin-signatures/weakRef.js";
import { weakSetSignatures } from "./builtin-signatures/weakSet.js";
import { webcryptoSignatures } from "./builtin-signatures/webcrypto.js";
import { websocketSignatures } from "./builtin-signatures/websocket.js";
import { webstreamSignatures } from "./builtin-signatures/webstream.js";
import { workerSignatures } from "./builtin-signatures/worker.js";
import { wrapperSignatures } from "./builtin-signatures/wrapper.js";
import { writableSignatures } from "./builtin-signatures/writable.js";
import { writerSignatures } from "./builtin-signatures/writer.js";
import { zlibSignatures } from "./builtin-signatures/zlib.js";

export type { LibFnSignature } from "./builtin-signatures/shared.js";

/** The closed native builtin call surface. Keep a call's semantics and ABI
 * together here; frontend coercion and IR validation consume the same table.
 * All arguments are required. Lowering supplies optional-source defaults
 * before this boundary and preserves their evaluation order. */
function buildLibFnSignatures() {
  return {
    ...abortSignatures,
    ...ahSignatures,
    ...alsSignatures,
    ...arSignatures,
    ...arraySignatures,
    ...arrayBufferSignatures,
    ...assertSignatures,
    ...asyncSignatures,
    ...atomicsSignatures,
    ...bigintSignatures,
    ...bigstatsSignatures,
    ...blobSignatures,
    ...bufferSignatures,
    ...bytesSignatures,
    ...childSignatures,
    ...classSignatures,
    ...closureSignatures,
    ...clusterSignatures,
    ...collectionSignatures,
    ...consoleSignatures,
    ...constantsSignatures,
    ...cpSignatures,
    ...cryptoSignatures,
    ...dateSignatures,
    ...dcSignatures,
    ...dgramSignatures,
    ...dirSignatures,
    ...disposableSignatures,
    ...dnsSignatures,
    ...duplexSignatures,
    ...dynSignatures,
    ...emitterSignatures,
    ...errorSignatures,
    ...eventSignatures,
    ...eventsSignatures,
    ...fetchSignatures,
    ...ffiSignatures,
    ...fileHandleSignatures,
    ...finalizationRegistrySignatures,
    ...fsSignatures,
    ...fspSignatures,
    ...globalSignatures,
    ...handleSignatures,
    ...httpSignatures,
    ...http2Signatures,
    ...httpsSignatures,
    ...icuSignatures,
    ...inspSignatures,
    ...intlSignatures,
    ...iteratorSignatures,
    ...jsSignatures,
    ...jsonSignatures,
    ...mathSignatures,
    ...mimeSignatures,
    ...mkdtempResultSignatures,
    ...moduleSignatures,
    ...navigatorSignatures,
    ...netSignatures,
    ...nodeIslandSignatures,
    ...numSignatures,
    ...numberSignatures,
    ...osSignatures,
    ...passthroughSignatures,
    ...pathSignatures,
    ...perfSignatures,
    ...procStreamSignatures,
    ...processSignatures,
    ...promiseSignatures,
    ...punycodeSignatures,
    ...qsSignatures,
    ...readableSignatures,
    ...recordSignatures,
    ...regexSignatures,
    ...regexpSignatures,
    ...rlSignatures,
    ...scSignatures,
    ...seaSignatures,
    ...sharedArrayBufferSignatures,
    ...sourceMapSignatures,
    ...spSignatures,
    ...spawnResSignatures,
    ...sqliteSignatures,
    ...statWatcherSignatures,
    ...statsSignatures,
    ...stdinSignatures,
    ...strSignatures,
    ...strdecSignatures,
    ...streamSignatures,
    ...stringSignatures,
    ...symSignatures,
    ...teSignatures,
    ...testSignatures,
    ...textSignatures,
    ...timersSignatures,
    ...tlsSignatures,
    ...tlscaSignatures,
    ...tpSignatures,
    ...transformSignatures,
    ...urlSignatures,
    ...urlpatternSignatures,
    ...utilSignatures,
    ...wasmSignatures,
    ...watchEventsSignatures,
    ...watcherSignatures,
    ...weakMapSignatures,
    ...weakRefSignatures,
    ...weakSetSignatures,
    ...webcryptoSignatures,
    ...websocketSignatures,
    ...webstreamSignatures,
    ...workerSignatures,
    ...wrapperSignatures,
    ...writableSignatures,
    ...writerSignatures,
    ...zlibSignatures,
  };
}

let libFnSignatureTable: ReturnType<typeof buildLibFnSignatures> | undefined;

/** The runtime call slots of every native builtin, keyed by name. The table
 * is built on the first call, so runs that neither lower nor validate a
 * module do not construct it. */
export function libFnSignatures(): ReturnType<typeof buildLibFnSignatures> {
  libFnSignatureTable ??= buildLibFnSignatures();
  return libFnSignatureTable;
}

/** A builtin name exists exactly when its runtime signature exists. */
export type IrLibFn = keyof ReturnType<typeof buildLibFnSignatures>;

/** The function-stage runs of a pipeline of `total` stages that a stream
 * follows (positions bit j: stage j is a function), and an async
 * generator destination's run (flags bits 1-2 = 1, pumped into the
 * PassThrough pipeline() answers, or 3, an untyped destination whose
 * result may be pumped there): each pumps its last generator through one
 * (next, read, return) triple. */
export function pipelinePumpedRuns(total: number, positions: number, flags: number): number {
  const dest = (flags >> 1) & 3;
  let runs = dest === 1 || dest === 3 ? 1 : 0;
  for (let j = 0; j + 1 < total; j++) {
    if (Math.floor(positions / 2 ** j) % 2 === 1 && Math.floor(positions / 2 ** (j + 1)) % 2 === 0)
      runs++;
  }
  return runs;
}
