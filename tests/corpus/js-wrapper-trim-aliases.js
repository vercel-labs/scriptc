// A String wrapper's trimLeft() and trimRight() (the Annex B aliases of
// trimStart() and trimEnd()) trim the wrapped string after the program reads
// String.prototype, as they do in Node. The read is what makes the prototype
// object the intrinsic table's object; the call on a wrapper must still reach
// the string lowering rather than the member's function value.
typeof String.prototype;

const padded = new String("  value  ");
console.log("[" + padded.trimLeft() + "]");
console.log("[" + padded.trimRight() + "]");
console.log("[" + padded.trimStart() + "]");
console.log("[" + padded.trimEnd() + "]");

const untouched = new String("value");
console.log(untouched.trimLeft(), untouched.trimRight(), untouched.length);

const viaCall = String.prototype.trimLeft.call(new String("\t x "));
console.log("[" + viaCall + "]");
console.log("[" + String.prototype.trimRight.call("  x \n") + "]");

const wide = new String("   z   ");
console.log("[" + wide.trimLeft() + "]", "[" + wide.trimRight() + "]");

// Node's identity: the alias IS the method it aliases.
console.log(String.prototype.trimLeft === String.prototype.trimStart);
console.log(String.prototype.trimRight === String.prototype.trimEnd);
console.log(padded.trimLeft === padded.trimStart, padded.trimRight === padded.trimEnd);
