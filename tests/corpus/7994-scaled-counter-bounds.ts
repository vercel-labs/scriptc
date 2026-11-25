// A scaled loop guard (`2 * i < bound`) bounds the loop's typed-array
// accesses only for a non-negative counter: `i < bound` follows from
// `2 * i < bound` only when `i >= 0`. These loops enter with the counter
// below zero, at a positive access offset, and with negative bounds, so the
// guard must keep testing the counter's own entry value; out-of-range reads
// and ignored out-of-range writes then behave exactly as they do in
// JavaScript.
const source = new Uint8Array([11, 22, 33, 44, 55]);

function copies(start: number, bound: number): string {
  const out = new Uint8Array(8);
  let i = start;
  while (2 * i < bound) {
    out[i + 1]! = source[i + 1]!;
    i = i + 1;
  }
  return Array.from(out).join(",");
}

function reads(start: number, bound: number): string {
  const seen: (number | undefined)[] = [];
  let i = start;
  while (2 * i < bound) {
    seen.push(source[i + 1]);
    i = i + 1;
  }
  return seen.join(",");
}

function writes(start: number, bound: number): string {
  const slot = new Uint8Array(4);
  let i = start;
  while (2 * i < bound) {
    slot[i + 1]! = source[i + 1]!;
    i = i + 1;
  }
  return Array.from(slot).join(",");
}

function doubled(start: number, bound: number): string {
  const seen: number[] = [];
  let i = start;
  while (i * 2 < bound) {
    seen.push(source[i] ?? -1);
    i = i + 1;
  }
  return seen.join(",");
}

console.log("copies 0 6", copies(0, 6));
console.log("copies -1 3", copies(-1, 3));
console.log("copies -2 0", copies(-2, 0));
console.log("copies -3 -1", copies(-3, -1));
console.log("reads -1 2", reads(-1, 2));
console.log("reads -4 -2", reads(-4, -2));
console.log("reads 0 -1", reads(0, -1));
console.log("writes 0 12", writes(0, 12));
console.log("writes -2 4", writes(-2, 4));
console.log("doubled -2 1", doubled(-2, 1));
console.log("doubled -5 -3", doubled(-5, -3));
