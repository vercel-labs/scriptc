// DataView.prototype's setter family read as values in a JavaScript source:
// each setter coerces its offset with ToIndex and its value with ToNumber
// (ToBigInt for the 64-bit pair), so a missing value writes NaN's bytes, an
// omitted littleEndian flag means big-endian, and a foreign receiver is the
// brand check's TypeError. The bytes are read back through the view's own
// getters, which is the pair's agreement.

const setters = ["setInt8", "setUint8", "setInt16", "setUint16", "setInt32", "setUint32", "setFloat32", "setFloat64", "setBigInt64", "setBigUint64"];

for (const name of setters) {
  const fn = DataView.prototype[name];
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  console.log(
    name,
    typeof fn,
    fn.name,
    fn.length,
    desc.enumerable,
    desc.writable,
    desc.configurable,
  );
}

const view = new DataView(new ArrayBuffer(32));

DataView.prototype.setInt8.call(view, 0, -128);
DataView.prototype.setUint8.call(view, 1, 255);
DataView.prototype.setInt16.call(view, 2, -32768);
DataView.prototype.setUint16.call(view, 4, 65535);
DataView.prototype.setInt32.call(view, 6, -2147483648);
DataView.prototype.setUint32.call(view, 10, 4294967295);
DataView.prototype.setFloat32.call(view, 14, 1.5);
DataView.prototype.setFloat64.call(view, 16, -2.25);

console.log("int8", view.getInt8(0));
console.log("uint8", view.getUint8(1));
console.log("int16-be", view.getInt16(2));
console.log("uint16-be", view.getUint16(4));
console.log("int32-be", view.getInt32(6));
console.log("uint32-be", view.getUint32(10));
console.log("float32-be", view.getFloat32(14));
console.log("float64-be", view.getFloat64(16));

// The same writes with the littleEndian flag set land in the reflected
// order, which the big-endian read of the same bytes shows.
const swapped = new DataView(new ArrayBuffer(8));
DataView.prototype.setInt16.call(swapped, 0, 0x1234, true);
DataView.prototype.setInt32.call(swapped, 2, 0x12345678, true);
console.log("le-bytes", swapped.getUint8(0), swapped.getUint8(1), swapped.getUint8(2), swapped.getUint8(5));

// A setter's missing value is ToNumber(undefined) = NaN: every numeric kind
// stores zero bytes for it, and a missing offset is offset 0.
const cleared = new DataView(new ArrayBuffer(8));
cleared.setUint32(0, 0xffffffff);
DataView.prototype.setUint32.call(cleared, 0);
console.log("missing-value", cleared.getUint32(0));
cleared.setUint32(0, 0xffffffff);
DataView.prototype.setUint32.call(cleared);
console.log("missing-both", cleared.getUint32(0));
cleared.setFloat32(0, 3.5);
DataView.prototype.setFloat32.call(cleared, 0, "0.5");
console.log("string-value", cleared.getFloat32(0));

// The intrinsic path's own arity: a call that omits the value or the offset
// writes the same zero bytes, and an offset-only setBigInt64 call throws
// the TypeError ToBigInt(undefined) answers.
cleared.setInt8(0, 7);
cleared.setInt8(0);
console.log("intrinsic-missing-value", cleared.getInt8(0));
try {
  cleared.setBigInt64(0);
} catch (e) {
  console.log("bigint-missing-value", e.name);
}

// The 64-bit pair round-trips BigInts.
const wide = new DataView(new ArrayBuffer(16));
DataView.prototype.setBigInt64.call(wide, 0, -1n);
DataView.prototype.setBigUint64.call(wide, 8, 2n ** 64n - 1n, true);
console.log("bigint64", wide.getBigInt64(0));
console.log("biguint64", wide.getBigUint64(8, true));

// ToIndex runs before the value's conversion, so a negative offset is the
// RangeError even when the value could not convert either.
for (const [label, fn] of [
  ["negative-offset", () => DataView.prototype.setUint8.call(cleared, -1, 1)],
  ["huge-offset", () => DataView.prototype.setUint8.call(cleared, 2 ** 53, 1)],
  ["out-of-bounds", () => DataView.prototype.setInt32.call(cleared, 5, 1)],
]) {
  try {
    fn();
    console.log(label, "no-throw");
  } catch (e) {
    console.log(label, e.name, e.message);
  }
}

// A foreign receiver is the brand check's TypeError, whatever the value is.
for (const receiver of [{}, new Uint8Array(4), DataView.prototype, undefined]) {
  try {
    DataView.prototype.setUint8.call(receiver, 0, 1);
    console.log("brand", "no-throw");
  } catch (e) {
    console.log("brand", e.name, e.constructor === TypeError);
  }
}
