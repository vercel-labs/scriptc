// Array.prototype.concat over an array-like receiver in a program that never
// mentions Symbol. The array-like unit reads the receiver's
// @@isConcatSpreadable before it spreads, so it links the symbol unit even
// though the program's IR carries no symbol value. A primitive receiver is
// still the array-like unit's explicit refusal, so this program uses objects.
const receiver = { 0: "a", 1: "b", length: 2 };
const result = Array.prototype.concat.call(receiver, "x", ["y"]);
console.log(result.length, result[0] === receiver, result[1], result[2]);
console.log(Array.prototype.concat.call({ length: 0 }).length);
