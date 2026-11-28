// A member read on a checked-dynamic binding the checker narrowed to a
// bytes-holding class takes the dynamic own-property read with the checked
// value converted to the dynamic ABI: a DataView's buffer slice, an
// ArrayBuffer's own slice and a Uint8Array's length all lower, and none of
// them reaches the dynamic class helper as a typed receiver.
//
// `valueToClone.buffer.slice(0)`'s reads were an SC9001 ICE (call
// %dyn.class.property.N arg 0: expected dyn, got bytes).
function viewCopy(value) {
  if (value instanceof DataView) {
    const copy = value.buffer.slice(0);
    return [copy.byteLength, value.byteOffset, value.byteLength];
  }
  if (value instanceof ArrayBuffer) return [value.slice(0).byteLength];
  return null;
}

function bytesLength(value) {
  if (value instanceof Uint8Array) return value.length;
  return -1;
}

const buffer = new ArrayBuffer(8);
const view = new DataView(buffer, 2, 4);
console.log(viewCopy(view));
console.log(viewCopy(buffer));
console.log(viewCopy(3));
console.log(bytesLength(new Uint8Array([1, 2, 3])), bytesLength("abc"));
