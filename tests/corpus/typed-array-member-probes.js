// Feature probes and member reads on typed arrays and Buffers that their
// types do not declare: names Node 24's prototype chains lack read as
// undefined (the base64/hex probes libraries such as @noble/hashes make),
// `in` with a literal member name answers from the same chains,
// BYTES_PER_ELEMENT is the element size, and array destructuring
// assignment writes typed-array elements in order.
const bytes = new Uint8Array([1, 2, 3]);
const words = new Uint32Array(2);
const doubles = new Float64Array(2);
const buffer = Buffer.from([4, 5]);

console.log(typeof bytes.toHex, typeof bytes.toBase64, typeof Uint8Array.from([]).toHex);
console.log(bytes.notAMember, typeof doubles.setFromHex, typeof buffer.toHex);

let made = 0;
const fresh = () => {
  made++;
  return new Uint8Array(1);
};
console.log(typeof fresh().fromHex, made);

console.log("BYTES_PER_ELEMENT" in bytes, "subarray" in doubles, "constructor" in words);
console.log("toHex" in bytes, "notAMember" in buffer);
console.log(bytes.BYTES_PER_ELEMENT, words.BYTES_PER_ELEMENT, doubles.BYTES_PER_ELEMENT, buffer.BYTES_PER_ELEMENT);

const high = new Uint32Array(3);
const low = new Float64Array(3);
for (let i = 0; i < 3; i++) [high[i], low[i]] = [i * 2 ** 31, i + 0.5];
console.log(Array.from(high), Array.from(low));
[high[1], low[5]] = [7, 9];
console.log(Array.from(high), Array.from(low));

function isBytes(a) {
  return (
    a instanceof Uint8Array ||
    (ArrayBuffer.isView(a) && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1)
  );
}
console.log(isBytes(bytes), isBytes(doubles), isBytes(buffer));
