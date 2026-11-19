// buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]])'s offset
// conversion and validation: Node converts each offset with util's
// toInteger (NaN and every non-finite value become 0, other fractions
// floor) and then range-checks the converted value, reporting the floor it
// used. Ranges that point past the target copy what fits; the receiver is
// the source.
import { Buffer } from "node:buffer";

function shape(fn: () => number): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

const source = Buffer.from("abcdef");

function run(targetStart: number, sourceStart?: number, sourceEnd?: number): string {
  const target = Buffer.alloc(6, 0x2e);
  const count = shape(() => source.copy(target, targetStart, sourceStart, sourceEnd));
  return count + " " + target.toString("latin1");
}

// Whole-source copies.
console.log(run(0));
console.log(run(3));
console.log(run(6));
console.log(run(10));

// Fractions floor, so a negative fraction is out of range and reports the
// floor it used.
console.log(run(0.9));
console.log(run(2.5));
console.log(run(-0.5));
console.log(run(1.5, 0.5));
console.log(run(1.5, 0.5, 2.5));

// NaN and the infinities convert to 0.
console.log(run(0 / 0));
console.log(run(Infinity));
console.log(run(-Infinity));
console.log(run(0, 0 / 0));
console.log(run(0, Infinity));
console.log(run(0, -Infinity));
console.log(run(0, 0, 0 / 0));
console.log(run(0, 0, Infinity));
console.log(run(0, 0, -Infinity));
console.log(run(0, -1));
console.log(run(0, 0, -1));
console.log(run(0, 7));
console.log(run(2, 4, 100));
console.log(run(0, 5, 3));

// The receiver counts in bytes over its own whole storage, and a target view
// receives them byte by byte.
const wide = new Uint16Array([0x4241, 0x4443, 0x4645]);
const wideBytes = new Uint8Array(wide.buffer);
console.log(Buffer.from("abcd").copy(wideBytes), Buffer.from(wide.buffer).toString("latin1"));
const bytes = new Uint8Array(2);
console.log(Buffer.from("xyz").copy(bytes), Buffer.from(bytes).toString("latin1"));

// Copying from a subarray reads the window, not the backing store.
const backing = Buffer.from("0123456789");
const window = backing.subarray(3, 7);
const target = Buffer.alloc(10, 0x2e);
console.log(window.copy(target), target.toString("latin1"));
console.log(window.copy(target, 1, 1, 3), target.toString("latin1"));
console.log(window.copy(target, 1, 1, 3), target.toString("latin1"));

// copy answers the number of bytes moved, and an empty range moves none.
const empty = Buffer.alloc(4);
console.log(empty.copy(empty), Buffer.alloc(0).copy(Buffer.alloc(1)), source.copy(Buffer.alloc(0)));
