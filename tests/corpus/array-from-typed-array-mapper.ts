// `Array.from(typedArray, mapper)`: the mapper receives each element as a
// number and its index, and the element reads are LIVE — iteration reads
// index i after visiting i-1, so a mapper that writes the source changes
// the values the loop has not visited yet. The result is a plain array of
// the mapper's results.

const bytes = new Uint8Array([104, 105, 33]);
console.log(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
console.log(Array.from(bytes, (byte, index) => `${index}:${byte}`).join(","));

const live = new Uint8Array([1, 2, 3]);
const doubled = Array.from(live, (value, index) => {
  if (index === 0) live[2] = 30;
  return value * 2;
});
console.log(doubled.join(","));

// A mapper that ignores its parameters, and an empty source.
console.log(Array.from(new Uint8Array(0), () => 7).length);
console.log(Array.from(bytes, () => "x").join(""));

// Element identity survives the map: objects are not copied.
const words = new Uint8Array([1, 2]);
const boxed = Array.from(words, (word) => ({ word }));
console.log(boxed.length, boxed[1]!.word);
