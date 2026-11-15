// Math.max/Math.min/Math.hypot with an untyped spread among other
// arguments: every value the iteration yields folds through ToNumber, in
// argument order, as Node's variadic forms do.
function caps(list) {
  return list.map((c) => c[0]);
}
console.log(Math.max(-1, ...caps([["7"], [true], [null]])));
console.log(Math.min(10, ...caps([["3"], [undefined]])));
console.log(Math.max(-1, ...caps([[{}], [4]])));
const order = [];
const valued = (n) => ({
  valueOf() {
    order.push(n);
    return n;
  },
});
console.log(Math.max(-1, ...caps([[valued(2)], [valued(5)]])), order.join(","));
console.log(Math.hypot(3, ...caps([["4"], [12]])));
console.log(Math.hypot(-1, ...caps([[Infinity], [NaN]])));
const empty = { values: () => new Map().keys() };
console.log(Math.max(-1, ...empty.values()));
