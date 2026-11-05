// Module-level `let` bindings that untyped code updates in loops: numbers,
// then values of other kinds, read by functions declared before and after.
function readTotal() {
  return total;
}
let total = 0;
let label = "n";
let mixed = 1;
let big = 10n;
let counter = 0;
var hoisted;
function bump(n) {
  return n * 2 + 1;
}
for (let i = 0; i < 1000; i++) {
  total += bump(i);
  label += i % 10 === 0 ? i : "";
  mixed = mixed * 1.5 + i;
  big += BigInt(i);
  counter++;
}
console.log(total, readTotal(), label.length, mixed, big, counter);
total = total / 0;
console.log(total, readTotal());
total = -0;
console.log(Object.is(total, -0), 1 / total);
total = NaN;
console.log(total === total, String(total));
mixed = "text";
mixed += 5;
console.log(mixed, typeof mixed);
mixed = { value: 3 };
mixed.value += 4;
console.log(mixed.value, JSON.stringify(mixed));
mixed = undefined;
console.log(mixed, typeof mixed, mixed ?? "fallback");
mixed = null;
console.log(mixed === null, `${mixed}`);
hoisted = 0;
for (let i = 0; i < 10; i++) hoisted += i * 0.1;
console.log(hoisted);
const add = (n) => {
  total = (Number.isNaN(total) ? 0 : total) + n;
  return total;
};
for (let i = 0; i < 5; i++) add(i);
console.log(total, readTotal());
let product = 1;
for (let i = 1; i <= 25; i++) product *= i;
console.log(product, product > Number.MAX_SAFE_INTEGER);
let text = 0;
for (let i = 0; i < 3; i++) text = text + "" + i;
console.log(text, typeof text);
