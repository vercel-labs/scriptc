// `.filter(Boolean)` and `.map(Number)` on an untyped receiver write a
// primitive constructor as a value, but no typed slot holds its function
// type: the held-constructor comparison never runs, and the program builds
// and runs as under Node.
const values: any[] = [0, 1, "", "x", null, undefined];
const kept = values.filter(Boolean);
const mapped = values.map(Number);
console.log(JSON.stringify(kept), JSON.stringify(mapped));
