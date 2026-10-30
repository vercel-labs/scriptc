// slimmed ships a one-long-line dist: minified JS compiles like any other
// eligible package.
import { pick } from "slimmed";

export function f(a: number, b: number): number {
  return pick(a, b);
}
