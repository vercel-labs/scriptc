// Buffer.concat over an untyped list (JavaScript's `const chunks = []`):
// Uint8Array elements concatenate, the length form pads or truncates, and
// a non-array list or a non-Uint8Array element throws Node's TypeError. The
// length form checks the length before the elements, and an empty list
// returns before either.
const chunks = [];
chunks.push(Buffer.from("ab"));
chunks.push(new Uint8Array([99, 100]));
console.log(Buffer.concat(chunks).toString());
console.log(Buffer.concat(chunks, 6));
console.log(Buffer.concat(chunks, 3).toString());
console.log(Buffer.concat([]).length);

const lists = [[1], ["a"], [Buffer.from("x"), null], "x", 5, [new Uint16Array(1)]];
for (const list of lists) {
  try {
    Buffer.concat(list);
    console.log("no error");
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

const withLength = [
  [[1], -1],
  [[Buffer.from("a"), "b"], NaN],
  [[1], 2],
  [[], -1],
  [[Buffer.from("a")], 1.5],
  [[Buffer.from("a"), Buffer.from("b")], 2],
];
for (const [list, length] of withLength) {
  try {
    console.log("length", Buffer.concat(list, length).length);
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
