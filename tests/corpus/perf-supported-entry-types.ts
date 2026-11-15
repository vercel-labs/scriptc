// PerformanceObserver.supportedEntryTypes: Node's fixed entry-type list, one
// frozen array that every read answers, in index order and through every
// collection operation; a checked-dynamic read observes the same frozen
// array, and writes to it throw Node's messages.
import { PerformanceObserver } from "node:perf_hooks";

const first = PerformanceObserver.supportedEntryTypes;
const second = PerformanceObserver.supportedEntryTypes;
console.log("same:", first === second, Object.isFrozen(first), Array.isArray(first));
console.log("json:", JSON.stringify(first));
console.log("length:", first.length, first[0], first[first.length - 1], first[5]);
console.log("includes:", first.includes("mark"), first.includes("measure"), first.includes("gc"));
console.log("indexOf:", first.indexOf("http2"), first.indexOf("function"), first.indexOf("net"));
console.log("slice:", first.slice(0, 3).join(","), first.slice(-2).join(","));
console.log("join:", first.join("|"));
console.log("spread:", [...first].length, [...first].reverse().slice(0, 2).join(","));
console.log("sorted:", [...first].sort().join(","));
let walked = 0;
let marks = 0;
for (const type of first) {
  walked++;
  if (type === "mark") marks++;
}
console.log("for-of:", walked, marks);
console.log("map:", first.map((type) => type.length > 3).filter(Boolean).length);
console.log("every:", first.every((type) => typeof type === "string" && type.length > 0));

// The same array through a checked-dynamic slot: one array, still frozen.
const anyFirst: any = first;
const anySecond: any = PerformanceObserver.supportedEntryTypes;
console.log("dyn same:", anyFirst === anySecond, Object.isFrozen(anyFirst), Array.isArray(anyFirst));
console.log("dyn length:", anyFirst.length, anyFirst[9], typeof anyFirst.includes);
console.log("dyn json:", JSON.stringify(anyFirst));

// A frozen array refuses writes with Node's messages, and no write lands.
const writable = first as string[];
try {
  writable.push("zzz");
  console.log("push succeeded");
} catch (e) {
  console.log("push:", (e as Error).name, (e as Error).message);
}
try {
  writable[0] = "zzz";
  console.log("write succeeded");
} catch (e) {
  console.log("write:", (e as Error).name, (e as Error).message);
}
try {
  writable.length = 2;
  console.log("truncate succeeded");
} catch (e) {
  console.log("truncate:", (e as Error).name, (e as Error).message);
}
console.log("after:", JSON.stringify(PerformanceObserver.supportedEntryTypes));
console.log("dyn write:", typedWriteRefused(anyFirst));
function typedWriteRefused(value: any): boolean {
  try {
    value.push("zzz");
    return false;
  } catch {
    return true;
  }
}
