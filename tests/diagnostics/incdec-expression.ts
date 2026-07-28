// SC1045: increment/decrement of record fields or array elements in
// expression position is not yet supported — the read-modify-write
// desugar only works in statement position for non-class-field receivers.
const obj = { x: 1 };
let y = obj.x++;
const arr = [1, 2, 3];
let z = arr[0]++;
console.log(y, z);
