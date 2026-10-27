// Indexing a string with a JavaScript value the checker types as a union of
// a number and a string (an element of an array literal, which infers
// `(string | number)[]`): JavaScript reads the property the key names, a
// code unit for an integer, the length for "length", else undefined.
const entries = ["length", 1, "nope", 9, 1.5];
for (let i = 0; i < entries.length; i++) {
  const key = entries[i];
  const read = "hello"[key];
  console.log(typeof key, read, typeof read);
}
const missing = entries[10];
console.log("hello"[missing]);
