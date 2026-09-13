// Builtin conversions consume the missing value produced by an unchecked
// array read with JavaScript's own undefined semantics.
const values = ["a=1"];
const present = values[0];
const missing = values[9];

console.log(new URLSearchParams(present).toString());
console.log(new URLSearchParams(missing).toString(), new URLSearchParams(missing).size);

console.log(Number(present), Number.isNaN(Number(missing)));

console.log(JSON.stringify(present));
console.log(JSON.stringify(missing), JSON.stringify(missing) === undefined);
