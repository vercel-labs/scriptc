import type { ContextFn, Interval, NormalizedInterval } from "../types.ts";
export declare function normalizeInterval(
  context: ContextFn<Date> | undefined,
  interval: Interval,
): NormalizedInterval<Date>;
