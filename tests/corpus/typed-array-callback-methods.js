// Typed-array callback methods called from JavaScript, with untyped
// callback parameters and a function expression.
const a = new Float64Array([1, 2, 3]);
console.log(a.map((x) => x / 2).join(" "), a.filter((x) => x % 2).length, a.reduce((s, x) => s + x));
a.forEach(function (x, i) { console.log(i, x); });
const b = Buffer.from([1, 2, 3]);
console.log(Buffer.isBuffer(b.map((x) => x * 2)), Buffer.isBuffer(b.filter((x) => x > 1)));
console.log(b.findLastIndex((x) => x < 3), b.every((x) => x > 0));
