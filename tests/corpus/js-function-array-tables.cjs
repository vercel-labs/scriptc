'use strict';
// Test tables that mix functions with arrays of cases, iterated through
// for-of and forEach with destructuring (JavaScript infers a union of
// functions and arrays for each row's items).
function add(a, b) { return a + b; }
function mul(a, b) { return a * b; }

const table = [
  [add, [[1, 2], [3, 4]]],
  [mul, [[5, 6], [0, 9]]],
];
for (const [fn, cases] of table) {
  for (const [a, b] of cases) console.log(fn.name, a, b, fn(a, b));
}
table.forEach(([fn, cases]) => {
  cases.forEach(([a, b]) => console.log('forEach', fn.name, fn.apply(null, [a, b])));
});
for (const row of table) {
  const [fn, cases] = row;
  console.log(typeof fn, Array.isArray(cases), cases.length, fn === add || fn === mul);
}

const nested = [[Math.max, [[1, 7, 3]]], [Math.min, [[4, -2]]]];
for (const [pick, lists] of nested) for (const list of lists) console.log(pick(...list));
