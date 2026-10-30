// Math functions and ** over untyped values print the values Node prints
// (V8's fdlibm results, and V8's pow special cases).
const values = JSON.parse("[0.3, 0.75, 2.5, -7.25, 1e-8, 123456.789, 1e21]");
const rows = [];
for (const x of values) {
  rows.push([Math.sin(x), Math.cos(x), Math.tan(x), Math.exp(x / 100), Math.cbrt(x), Math.atan2(x, 3)].join(" "));
  rows.push([Math.log(Math.abs(x)), Math.log10(Math.abs(x)), Math.sinh(x / 1e5), Math.cosh(x / 1e5), Math.expm1(x / 1e6)].join(" "));
  rows.push([x ** 2, x ** 0.5, Math.abs(x) ** 0.3, x % 1.5].join(" "));
}
console.log(rows.join("\n"));
const edges = JSON.parse('[1, -1, null]');
console.log(edges[0] ** Infinity, edges[1] ** -Infinity, Number(edges[2]) ** 0.5, (-Infinity) ** 0.5);
