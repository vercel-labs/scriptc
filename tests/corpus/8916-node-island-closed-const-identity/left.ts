import { Kit, type Shape } from "shape-kit";
import { shared } from "./shapes.ts";

export const fromLeft = Kit.list(shared);
export function sameInLeft(shape: Shape): boolean {
  return shape === shared;
}
