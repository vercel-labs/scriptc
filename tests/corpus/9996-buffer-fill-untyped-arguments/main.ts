// buf.fill(value, offset, end, encoding) where an argument has no static
// type that names a typed fill: a natively compiled CommonJS package passes
// its own untyped parameters on, and typed TypeScript passes a union, an
// `any`, or an encoding beside a number. Node's fill reads the kind each
// argument has when the call runs: a string takes its encoding from the
// first string among the offsets, a view repeats its bytes, any other value
// fills as a number & 255, and the offsets must be numbers in range.
import { report } from "stripe-kit";

for (const line of report()) console.log(line);

function show(thunk: () => Buffer): string {
  try {
    return thunk().toString("hex");
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + (err.code ? " " + err.code : "") + ": " + String(err.message).split("\n")[0];
  }
}
const flag = process.argv.length > 99;
const either: string | number = flag ? "a" : 9;
const anything: any = flag ? 1 : "6162";
console.log("typed number, range and encoding -> " + show(() => Buffer.alloc(4).fill(1, 0, 2, "utf8")));
console.log("typed union -> " + show(() => Buffer.alloc(4).fill(either, 1)));
console.log("typed any -> " + show(() => Buffer.alloc(4).fill(anything, 1, 3, "hex")));
console.log("typed any offset -> " + show(() => Buffer.alloc(4).fill(5, anything)));
