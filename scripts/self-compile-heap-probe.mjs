/* Preload for a budgeted self-compile (scripts/self-compile-budget.mjs): node --expose-gc
 * --import <this file>. With SCRIPTC_TIMING=1 the frontend ends every whole-program lowering pass
 * with a `scriptc lowering` line. At each of them this collects garbage and reports what is still
 * reachable as a `scriptc heap` line, so the heap is read at the same points of every build,
 * however the collector happened to be scheduled. A frontend that runs in its own process inherits
 * the options and reports for itself. */
import v8 from "node:v8";

if (typeof globalThis.gc === "function" && process.env.SCRIPTC_TIMING === "1") {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const written = write(chunk, ...rest);
    const pass =
      typeof chunk === "string"
        ? /^scriptc lowering \{"phase":"(reachable-emit|[a-z-]+-relower)"/.exec(chunk)
        : null;
    if (pass !== null) {
      globalThis.gc();
      const live = v8.getHeapStatistics().used_heap_size;
      write(
        `scriptc heap ${JSON.stringify({ phase: pass[1], live_mb: Math.round(live / 2 ** 20) })}\n`,
      );
    }
    return written;
  };
}
