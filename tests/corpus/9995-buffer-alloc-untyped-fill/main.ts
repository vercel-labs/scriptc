// Buffer.alloc(size, fill, encoding) where the fill or the encoding has no
// static type that names a typed fill: a natively compiled CommonJS package
// passes its own untyped parameters on, and typed TypeScript passes a union,
// an `any`, or an encoding beside a number. Node reads the kind each value
// has when the call runs: a string with its encoding, a view's bytes, any
// other value as a number & 255, and no fill at all for a size of zero.
import { report } from "pad-kit";

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
const maybe: BufferEncoding | undefined = flag ? "hex" : undefined;
console.log("typed number and encoding -> " + show(() => Buffer.alloc(3, 1, "utf8")));
console.log("typed union -> " + show(() => Buffer.alloc(3, either)));
console.log("typed any and hex -> " + show(() => Buffer.alloc(3, anything, "hex")));
console.log("typed string and any -> " + show(() => Buffer.alloc(3, "6162", anything)));
console.log("typed string and optional encoding -> " + show(() => Buffer.alloc(3, "ab", maybe)));
