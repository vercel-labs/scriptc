import { describe } from "shape-kit";
import { shared } from "./shapes.ts";

export function describeShared(): string {
  return describe(shared);
}
