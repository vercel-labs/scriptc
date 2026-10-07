import type { IrExpr, IrModule, IrStmt, SrcLoc } from "../ir/ir.js";
import { everyExprChild, everyModuleNode, everyStmtChild } from "../ir/traverse.js";
import { moduleRuntimeFeatures } from "../ir/runtime-features.js";

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
  ["fs.callback", "the async filesystem callback surface"],
  ["zlib.deflateCb", "the async node:zlib callback surface"],
  ["zlib.inflateCb", "the async node:zlib callback surface"],
  ["zlib.deflateRawCb", "the async node:zlib callback surface"],
  ["zlib.inflateRawCb", "the async node:zlib callback surface"],
  ["zlib.gzipCb", "the async node:zlib callback surface"],
  ["zlib.gunzipCb", "the async node:zlib callback surface"],
  ["zlib.unzipCb", "the async node:zlib callback surface"],
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
  ["worker.new", "native worker threads"],
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
  ["childWriter", "the child_process surface"],
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
]);

/** First async/event-loop/ambient-process surface the module graph
 * reaches, or null when the graph is async_free (the v1 library requirement).
 * Typed slots use their declaration location and executable nodes use their
 * own location, so the refusal anchors at the reaching construct; the
 * coarse moduleUses* predicates are the safety net behind the fine-grained
 * table (a surface reached only through a spelling the table misses still
 * refuses, anchored at the entry). */
export function moduleLibAsyncSurface(mod: IrModule): { surface: string; loc: SrcLoc } | null {
  for (const fn of mod.functions) {
    if (fn.async === true)
      return { surface: `an async function ('${fn.name.replace(/^%/, "")}')`, loc: fn.loc };
    if (fn.generator !== undefined) {
      return { surface: `a generator function ('${fn.name.replace(/^%/, "")}')`, loc: fn.loc };
    }
  }
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  let found: { surface: string; loc: SrcLoc } | null = null;
  const checkKind = (kind: string, loc: SrcLoc): boolean => {
    const surface = LIB_MODE_REFUSED_KINDS.get(kind);
    if (surface === undefined) return true;
    found = { surface, loc };
    return false;
  };
  everyModuleNode(mod, {
    type: (node, loc) => checkKind(node.kind, loc),
    stmt: () => true,
    expr: (node) => {
      if (!checkKind(node.kind, node.loc)) return false;
      if (node.kind === "libCall") {
        for (const [prefix, surface] of LIB_MODE_REFUSED_PREFIXES) {
          if (node.fn.startsWith(prefix)) {
            found = { surface, loc: node.loc };
            return false;
          }
        }
      }
      return true;
    },
  });
  if (found !== null) return found;
  // Safety net: the coarse unit predicates, entry-anchored. Every one of
  // these units is excluded from library links, so a true answer that the
  // fine-grained table missed must still refuse.
  const features = moduleRuntimeFeatures(mod);
  const coarse: [boolean, string][] = [
    [mod.workers === true, "native worker threads"],
    [features.processEvents, "process signal/exit listeners or the stdin event surface"],
    [features.net, "the node:net surface"],
    [features.http, "the node:http surface"],
    [features.http2, "the node:http2 surface"],
    [features.dgram, "the node:dgram surface"],
    [features.fsWatch, "fs.watch"],
    [features.stream, "the node:stream surface"],
    [features.tls, "the node:tls surface"],
    [features.fetch, "fetch"],
    [features.nodeTest, "the node:test surface"],
    [features.dynAsync, "the checked-dynamic async surface"],
    [features.dc, "the diagnostics_channel surface"],
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
  ["process.rows", "terminal geometry (rows)"],
  ["process.kill", "process authority (kill)"],
  ["process.umask", "process authority (umask)"],
  ["process.exit", "process authority (exit)"],
  ["process.setExitCode", "process authority (exit status)"],
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
  const expr = (node: IrExpr): boolean => {
    if (node.kind === "libCall") {
      for (const [prefix, surface] of LIB_NONDETERMINISTIC_PREFIXES) {
        if (node.fn.startsWith(prefix)) {
          found = surface;
          return false;
        }
      }
    }
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => everyStmtChild(node, expr, stmt);
  for (const fn of mod.functions) {
    if (!fn.body.every(stmt)) break;
  }
  return found;
}
