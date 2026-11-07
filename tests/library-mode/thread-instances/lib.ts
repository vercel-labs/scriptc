// Thread-instanced fixture (prefix mt_): mutable module state each embedder
// thread's instance advances independently, allocation-heavy work that
// churns each instance's own collector, and a deliberately trapping export
// (array index OOB — the runtime's own range trap) that must reach only the
// calling thread's sink. No top-level output: four instances init
// concurrently in the probe.
import { performance } from "node:perf_hooks";

let calls = 0;

export function bump(x: number): number {
  calls++;
  return x + calls;
}

export function callsSeen(): number {
  return calls;
}

export function sumTo(n: number): number {
  const xs: number[] = [];
  for (let i = 1; i <= n; i++) xs.push(i);
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function boom(i: number): number {
  const xs = [1, 2, 3];
  return xs[i]!;
}

export function uptime(): number {
  return process.uptime();
}

export function perfNow(): number {
  return performance.now();
}

// Each calling thread builds and indexes its own large mixed-Unicode string.
// This reaches the SCR_TL sparse-checkpoint table without sharing any owned
// metadata between the archive's thread instances.
export function indexedUnicode(): number {
  const s = "aé😀é".repeat(12000);
  const mid = Math.floor(s.length / 2 / 6) * 6;
  return s.length + s.charCodeAt(mid + 2) + s.slice(mid + 1, mid + 4).length +
    s.substring(mid + 2, mid + 4).length + s.indexOf("é😀", mid) + s.lastIndexOf("😀");
}

// One generic declaration held at two signatures is one function object in
// each thread's instance. The instances' interned closures are thread-local
// here, so no initializer can name the declaration's identity root: each
// thread's init entry stores it. 31 when identity, set membership and both
// instances' calls all answer as JavaScript does.
function pick<T>(box: { v: T }): T {
  return box.v;
}
const pickNumber: (box: { v: number }) => number = pick;
const pickString: (box: { v: string }) => string = pick;

export function genericIdentity(): number {
  const a: unknown = pickNumber;
  const b: unknown = pickString;
  const members = new Set<unknown>([a, b]);
  return (
    (a === b ? 1 : 0) +
    (Object.is(a, b) ? 2 : 0) +
    (members.size === 1 ? 4 : 0) +
    pickNumber({ v: 8 }) +
    pickString({ v: "x" }).length * 16
  );
}
