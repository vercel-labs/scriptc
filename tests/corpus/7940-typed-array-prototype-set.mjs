// Uint8Array.prototype.set borrowed through .call on untyped receivers.
let cached = null;
function memory() {
  if (cached === null) cached = new Uint8Array(4);
  return cached;
}
function copy(target, source, offset) {
  return Uint8Array.prototype.set.call(target, source, offset);
}
console.log(copy(memory(), new Uint8Array([3, 4]), 1));
console.log(String(memory()));
copy(memory(), [9], undefined);
console.log(String(memory()));

// Every typed array shares %TypedArray%.prototype.set.
const wide = new Int16Array(3);
copy(wide, [1, -2], 1);
console.log(String(wide));
Float64Array.prototype.set.call(memory(), new Uint8Array([7]), 3);
console.log(String(memory()));

const order = [];
const arg = (label, value) => {
  order.push(label);
  return value;
};
for (const target of [{}, [0, 0], "ab", null, new DataView(new ArrayBuffer(2))]) {
  order.length = 0;
  try {
    Uint8Array.prototype.set.call(arg("target", target), arg("source", [1]), arg("offset", 0));
    console.log("set");
  } catch (e) {
    console.log(e instanceof TypeError, e.message, order.join(","));
  }
}
try {
  copy(memory(), [1, 2], 3);
} catch (e) {
  console.log(e instanceof RangeError, e.message);
}
