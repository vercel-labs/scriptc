import type { RoundingMethod } from "../types.ts";
export declare function getRoundingMethod(
  method: RoundingMethod | undefined,
): (number: number) => number;
