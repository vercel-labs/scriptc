// A String wrapper's trimLeft() and trimRight() in a program that never reads
// String.prototype: the wrapper unit's own member table answers the member
// read, and both spellings must still reach the same canonical method and
// trim the wrapped string, as in Node.
const padded = new String("  value  ");
console.log("[" + padded.trimLeft() + "]");
console.log("[" + padded.trimRight() + "]");
console.log(padded.trimLeft === padded.trimStart, padded.trimRight === padded.trimEnd);

const untouched = new String("value");
console.log(untouched.trimLeft(), untouched.trimRight(), untouched.length);
