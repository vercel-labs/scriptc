import type { IrLibFn } from "./builtin-signatures.js";
import { abortNeverThrow } from "./builtin-never-throw/abort.js";
import { ahNeverThrow } from "./builtin-never-throw/ah.js";
import { alsNeverThrow } from "./builtin-never-throw/als.js";
import { arNeverThrow } from "./builtin-never-throw/ar.js";
import { bytesNeverThrow } from "./builtin-never-throw/bytes.js";
import { childNeverThrow } from "./builtin-never-throw/child.js";
import { closureNeverThrow } from "./builtin-never-throw/closure.js";
import { clusterNeverThrow } from "./builtin-never-throw/cluster.js";
import { consoleNeverThrow } from "./builtin-never-throw/console.js";
import { cryptoNeverThrow } from "./builtin-never-throw/crypto.js";
import { dcNeverThrow } from "./builtin-never-throw/dc.js";
import { dgramNeverThrow } from "./builtin-never-throw/dgram.js";
import { dnsNeverThrow } from "./builtin-never-throw/dns.js";
import { dynNeverThrow } from "./builtin-never-throw/dyn.js";
import { emitterNeverThrow } from "./builtin-never-throw/emitter.js";
import { errorNeverThrow } from "./builtin-never-throw/error.js";
import { eventsNeverThrow } from "./builtin-never-throw/events.js";
import { fsNeverThrow } from "./builtin-never-throw/fs.js";
import { globalNeverThrow } from "./builtin-never-throw/global.js";
import { httpNeverThrow } from "./builtin-never-throw/http.js";
import { http2NeverThrow } from "./builtin-never-throw/http2.js";
import { inspNeverThrow } from "./builtin-never-throw/insp.js";
import { mkdtempResultNeverThrow } from "./builtin-never-throw/mkdtempResult.js";
import { moduleNeverThrow } from "./builtin-never-throw/module.js";
import { netNeverThrow } from "./builtin-never-throw/net.js";
import { nodeIslandNeverThrow } from "./builtin-never-throw/nodeIsland.js";
import { perfNeverThrow } from "./builtin-never-throw/perf.js";
import { processNeverThrow } from "./builtin-never-throw/process.js";
import { promiseNeverThrow } from "./builtin-never-throw/promise.js";
import { readableNeverThrow } from "./builtin-never-throw/readable.js";
import { recordNeverThrow } from "./builtin-never-throw/record.js";
import { seaNeverThrow } from "./builtin-never-throw/sea.js";
import { sourceMapNeverThrow } from "./builtin-never-throw/sourceMap.js";
import { sqliteNeverThrow } from "./builtin-never-throw/sqlite.js";
import { statWatcherNeverThrow } from "./builtin-never-throw/statWatcher.js";
import { streamNeverThrow } from "./builtin-never-throw/stream.js";
import { teNeverThrow } from "./builtin-never-throw/te.js";
import { testNeverThrow } from "./builtin-never-throw/test.js";
import { textNeverThrow } from "./builtin-never-throw/text.js";
import { timersNeverThrow } from "./builtin-never-throw/timers.js";
import { tlsNeverThrow } from "./builtin-never-throw/tls.js";
import { utilNeverThrow } from "./builtin-never-throw/util.js";
import { urlpatternNeverThrow } from "./builtin-never-throw/urlpattern.js";
import { watchEventsNeverThrow } from "./builtin-never-throw/watchEvents.js";
import { watcherNeverThrow } from "./builtin-never-throw/watcher.js";
import { weakMapNeverThrow } from "./builtin-never-throw/weakMap.js";
import { weakRefNeverThrow } from "./builtin-never-throw/weakRef.js";
import { websocketNeverThrow } from "./builtin-never-throw/websocket.js";
import { webstreamNeverThrow } from "./builtin-never-throw/webstream.js";
import { workerNeverThrow } from "./builtin-never-throw/worker.js";
import { zlibNeverThrow } from "./builtin-never-throw/zlib.js";

/** Builtins decided never to throw: the runtime function behind the call
 * cannot raise an error and cannot run program code (a getter, `toJSON`,
 * `valueOf`, `toString`, a proxy trap or a callback), under any argument.
 *
 * Every builtin states its answer once: a row in MAY_THROW_LIB_FNS
 * (builtin-effects.ts) or a row here. A builtin in neither is compiled
 * without the check that delivers its error, so the error is lost and the
 * caller reads a placeholder result. The compiler does not read this set;
 * packages/compiler/test/builtin-attributes.test.ts holds every builtin to
 * the rule, and builtin-throw-undecided.txt lists the builtins that
 * predate it. */
export const NEVER_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  ...abortNeverThrow,
  ...ahNeverThrow,
  ...alsNeverThrow,
  ...arNeverThrow,
  ...bytesNeverThrow,
  ...childNeverThrow,
  ...closureNeverThrow,
  ...clusterNeverThrow,
  ...consoleNeverThrow,
  ...cryptoNeverThrow,
  ...dcNeverThrow,
  ...dgramNeverThrow,
  ...dnsNeverThrow,
  ...dynNeverThrow,
  ...emitterNeverThrow,
  ...errorNeverThrow,
  ...eventsNeverThrow,
  ...fsNeverThrow,
  ...globalNeverThrow,
  ...httpNeverThrow,
  ...http2NeverThrow,
  ...inspNeverThrow,
  ...mkdtempResultNeverThrow,
  ...moduleNeverThrow,
  ...netNeverThrow,
  ...nodeIslandNeverThrow,
  ...perfNeverThrow,
  ...processNeverThrow,
  ...promiseNeverThrow,
  ...readableNeverThrow,
  ...recordNeverThrow,
  ...seaNeverThrow,
  ...sourceMapNeverThrow,
  ...sqliteNeverThrow,
  ...statWatcherNeverThrow,
  ...streamNeverThrow,
  ...teNeverThrow,
  ...testNeverThrow,
  ...textNeverThrow,
  ...timersNeverThrow,
  ...tlsNeverThrow,
  ...utilNeverThrow,
  ...urlpatternNeverThrow,
  ...watchEventsNeverThrow,
  ...watcherNeverThrow,
  ...weakMapNeverThrow,
  ...weakRefNeverThrow,
  ...websocketNeverThrow,
  ...webstreamNeverThrow,
  ...workerNeverThrow,
  ...zlibNeverThrow,
]);
