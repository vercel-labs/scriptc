// Members a typed array's type does not declare read as undefined only when
// Node's prototype chain lacks them for every value of the type. A Uint8Array
// may hold a Buffer, whose prototype has asciiSlice, so that read and that
// `in` test depend on the value and stay fenced.
const bytes: Uint8Array = Buffer.from("abc");
// @ts-ignore
console.log(typeof bytes.asciiSlice);
console.log("latin1Write" in bytes);
