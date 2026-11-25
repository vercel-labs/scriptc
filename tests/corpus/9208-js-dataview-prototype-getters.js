// DataView.prototype's getter family read as values in a JavaScript source:
// each member is one function object with the specification's name and
// length, and calling one through `.call` runs the getter's own algorithm —
// the receiver brand check, ToIndex on the offset, the view's RangeError for
// an offset it cannot reach, and the bytes read in the requested order.

const view = new DataView(new ArrayBuffer(24));
const getters = ["getInt8", "getUint8", "getInt16", "getUint16", "getInt32", "getUint32", "getFloat32", "getFloat64", "getBigInt64", "getBigUint64"];

for (const name of getters) {
  const fn = DataView.prototype[name];
  const desc = Object.getOwnPropertyDescriptor(DataView.prototype, name);
  console.log(
    name,
    typeof fn,
    fn.name,
    fn.length,
    DataView.prototype[name] === fn,
    desc.enumerable,
    desc.writable,
    desc.configurable,
  );
}

// The byte patterns the getters read, written through the view's own
// setters so the corpus pins the pair's agreement.
view.setInt8(0, -1);
view.setUint8(1, 200);
view.setInt16(2, -12345);
view.setUint16(4, 60000);
view.setInt32(6, -123456789);
view.setUint32(10, 4000000000);
view.setFloat32(14, 0.5);

console.log("int8", DataView.prototype.getInt8.call(view, 0));
console.log("uint8", DataView.prototype.getUint8.call(view, 1));
console.log("int16-be", DataView.prototype.getInt16.call(view, 2));
console.log("int16-le", DataView.prototype.getInt16.call(view, 2, true));
console.log("uint16-be", DataView.prototype.getUint16.call(view, 4));
console.log("uint16-le", DataView.prototype.getUint16.call(view, 4, true));
console.log("int32-be", DataView.prototype.getInt32.call(view, 6));
console.log("int32-le", DataView.prototype.getInt32.call(view, 6, true));
console.log("uint32-be", DataView.prototype.getUint32.call(view, 10));
console.log("uint32-le", DataView.prototype.getUint32.call(view, 10, true));
console.log("float32-be", DataView.prototype.getFloat32.call(view, 14));
console.log("float32-le", DataView.prototype.getFloat32.call(view, 14, true));

// The bigint pair answers BigInts, and their reads agree with the setters.
const wide = new DataView(new ArrayBuffer(16));
DataView.prototype.setBigInt64.call(wide, 0, -9007199254740991n);
DataView.prototype.setBigUint64.call(wide, 8, 18446744073709551615n);
console.log("bigint64", DataView.prototype.getBigInt64.call(wide, 0));
console.log("biguint64", DataView.prototype.getBigUint64.call(wide, 8));
console.log("bigint64-le", DataView.prototype.getBigInt64.call(wide, 0, true));

// ToIndex: a missing or undefined offset is 0, a numeric string and a
// fractional offset convert, a Symbol throws the TypeError a conversion
// answers, and a negative or unreachable offset is the view's RangeError.
console.log("missing-offset", DataView.prototype.getUint8.call(view));
console.log("undefined-offset", DataView.prototype.getUint8.call(view, undefined));
console.log("string-offset", DataView.prototype.getUint8.call(view, "1"));
console.log("fractional-offset", DataView.prototype.getInt16.call(view, 1.9));

for (const [label, argument] of [
  ["negative", -1],
  ["fractional-negative", -0.5],
  ["huge", 2 ** 53],
  ["infinity", Infinity],
  ["symbol", Symbol("offset")],
]) {
  try {
    console.log(label, DataView.prototype.getUint8.call(view, argument));
  } catch (e) {
    console.log(label, e.name);
  }
}

// The receiver brand check: a plain object, a typed array and a Buffer are
// not DataViews, and neither is the prototype object itself.
for (const receiver of [{}, [1, 2], new Uint8Array(4), DataView.prototype]) {
  try {
    console.log("brand", DataView.prototype.getUint8.call(receiver, 0));
  } catch (e) {
    console.log("brand", e.name, e.constructor === TypeError);
  }
}

// An offset past the view's end is the same RangeError the intrinsic path
// answers.
try {
  DataView.prototype.getInt32.call(view, 13);
} catch (e) {
  console.log("out-of-bounds", e.name, e.message);
}
