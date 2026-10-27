import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setHeapPressureCheck } from "./heap-pressure.js";

/** Calls of the check between two reads of the heap size, outside phase ends. */
const SAMPLE_INTERVAL = 64;
/** The heap grows by at least this much before a collection. */
const MIN_GROWTH_BYTES = 512 * 1024 * 1024;

/**
 * The check `collectGarbageUnderHeapPressure` installs: every 64th call, and at every phase end,
 * reads the used heap size and runs `collect` once it is at least twice the size after the
 * previous collection and 512 MB above it.
 */
export function heapPressureCheck(
  usedHeap: () => number,
  collect: () => void,
): (phase: boolean) => void {
  let live = usedHeap();
  let calls = 0;
  return (phase) => {
    if (!phase && ++calls % SAMPLE_INTERVAL !== 0) return;
    const used = usedHeap();
    if (used < Math.max(2 * live, live + MIN_GROWTH_BYTES)) return;
    collect();
    live = usedHeap();
  };
}

/**
 * Runs a full garbage collection from the compiler's allocation-heavy loops
 * (`relieveHeapPressure`) as `heapPressureCheck` decides. Without it, V8 lets the heap of a long
 * lowering or LLVM emission grow to several times its live size between full collections, and
 * Node keeps those pages for the life of the process.
 *
 * This sets --expose-gc for the process, so only the compiler's own processes call it (the CLI and
 * the frontend process, frontend-process.ts), not `compile()` callers.
 */
export function collectGarbageUnderHeapPressure(): void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") return;
  setHeapPressureCheck(
    heapPressureCheck(
      () => getHeapStatistics().used_heap_size,
      () => (gc as () => void)(),
    ),
  );
}
