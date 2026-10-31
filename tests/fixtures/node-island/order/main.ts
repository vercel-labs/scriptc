// JavaScript's evaluation order on island objects: a method call reads the
// method before its arguments run, and an assignment evaluates the receiver
// and the key before the value.
import { make, type Thing } from "orderkit";

const o = make();
// The argument replaces the method; the call still runs the one it read.
console.log((o.m as (...args: unknown[]) => string)((o.m = 0), 1));

const trace: string[] = [];
const target = make();
function receiver(): Thing {
  trace.push("receiver");
  return target;
}
function key(): string {
  trace.push("key");
  return "k";
}
function value(): number {
  trace.push("value");
  return 1;
}
receiver()[key()] = value();
receiver().p = value();
console.log(trace.join(","), target["k"], target["p"]);
