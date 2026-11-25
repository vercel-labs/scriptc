// `readonly` is a TypeScript annotation Node never sees. Assigning a
// `readonly` array type to a mutable binding (TS4104) freezes nothing, so the
// array keeps its runtime state: writes through either name succeed.
/** @type {readonly number[]} */
const source = [1, 2, 3];
let target = [0];
target = source;
console.log(target.length, target.join(","));
target.push(4);
console.log(target.length, target.join(","));
target[0] = 9;
console.log(target.join(","), source.join(","));

// The annotation travels with the value, not the binding: a copy typed from a
// readonly array is an ordinary mutable array again.
/** @type {readonly string[]} */
const names = ["a", "b"];
const copy = names.slice();
copy.push("c");
console.log(copy.length, names.length, copy.join(","));
