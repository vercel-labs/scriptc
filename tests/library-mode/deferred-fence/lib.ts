// A library whose TypeScript entry calls a JavaScript module that holds a
// construct with no lowering (RegExp.prototype.compile, SC2020): a deferred
// refusal at the call inside helper.js. In a library the refusal is the
// plain catchable Error: the archive carries no stderr reporter, so it
// links with nothing but the runtime it always had.
import { recompile } from "./helper.js";

export function run(n: number): number {
  const answer: unknown = recompile(n);
  return typeof answer === "number" ? answer : -1;
}
