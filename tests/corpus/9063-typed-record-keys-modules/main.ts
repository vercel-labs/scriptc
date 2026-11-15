// A fully typed program of several modules: one of them enumerates a constant
// object's keys, and this one passes a closure over module state to a
// function. Nothing here is untyped, so the executable links no part of the
// dynamic object model (tests/harness/typed-record-dynamic-tier.test.ts).
import { value004 } from "./m004.ts";

let calls = 0;
const step = 6;
const bump = (by: number): number => {
  calls += by;
  return calls * step;
};
const twice = (f: (by: number) => number, by: number): number => f(by) + f(by);
const own = twice(bump, 3) + calls;

export const out: number = (own + value004) % 1000003;
console.log(out);
