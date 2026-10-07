function scale(value: number): number { return value * 3; }
function forward(value: number): number { return scale(value) + 1; }
function rewrite(value: number): number { if (value < 0) value = 2; return value | 0; }
function observe(value: number | undefined): string { return `${typeof value}:${String(value)}`; }
function fallback(value: number | undefined): number { return value === undefined ? 19 : value + 1; }
function retain(value: number | undefined): number | undefined { return value; }
function mayAssign(value: number | undefined): string { value = undefined; return observe(value); }
function capture(value: number | undefined): () => string { return () => observe(value); }
function factorial(value: number | undefined): number { return value === undefined ? -1 : value <= 1 ? 1 : value * factorial(value - 1); }
const values: number[] = [4, NaN, -0, Infinity, -Infinity, 1.25];
for (let i = 0; i <= values.length; i++) {
  const value = values[i];
  console.log(scale(value), forward(value), rewrite(value), observe(value), fallback(value), retain(value), capture(value)());
}
for (const value of [5, NaN, -0, Infinity, -Infinity, 1.25]) {
  console.log(scale(value), forward(value), rewrite(value), observe(value), fallback(value), retain(value), capture(value)());
}
console.log(mayAssign(3), factorial(6), factorial(undefined));
const indirect = observe;
console.log(indirect(undefined), indirect(-0));
const order: string[] = [];
function argument(): number { order.push("argument"); return 8; }
function pair(a: number | undefined, b: number | undefined): number { return (a ?? 3) + (b ?? 4); }
console.log(pair(argument(), argument()), order.join(","));
console.log(pair(undefined, 1), pair(2, undefined));

function scale_nativeNumber(value: number): number { return value + 9; }
console.log(scale_nativeNumber(1));
