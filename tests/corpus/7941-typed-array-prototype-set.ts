// Uint8Array.prototype.set borrowed through .call on typed receivers.
const target = new Uint8Array(4);
Uint8Array.prototype.set.call(target, new Uint8Array([3, 4]), 1);
console.log(String(target));
Uint8Array.prototype.set.call(target, [5]);
console.log(String(target));

const wide = new Int32Array(3);
Uint8Array.prototype.set.call(wide, new Uint8Array([200, 100]), 1);
console.log(String(wide));

function fill(view: Uint8Array, bytes: number[], at: number): void {
  Uint8Array.prototype.set.call(view, bytes, at);
}
fill(target, [8, 9], 2);
console.log(String(target));
try {
  fill(target, [1, 2, 3], 2);
} catch (e) {
  console.log(e instanceof RangeError, (e as Error).message);
}
