import type Box from "./box.ts";
import { type Size } from "./box.ts";

export type { Box, Size };
export type { Box as default };

export function perimeter(size: Size): number {
  return 2 * (size.w + size.h);
}
