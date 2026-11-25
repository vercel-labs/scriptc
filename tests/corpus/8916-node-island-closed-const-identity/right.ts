import { Kit, type Shape } from "shape-kit";
import { shared } from "./shapes.ts";

export const fromRight = Kit.list(shared);
export function sameInRight(shape: Shape): boolean {
  return shape === shared;
}
