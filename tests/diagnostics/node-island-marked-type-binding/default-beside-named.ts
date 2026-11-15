import Box, { unit } from "./box.ts";

export function scaled(box: Box): number {
  return box.w * box.h * unit;
}
