// Math.max and Math.min with spreads among other arguments: the arguments
// in order, each spread flattened, fold with NaN poisoning, -0 below +0,
// and the empty fold's infinities.
const xs = [3, 1, 4];
console.log(Math.max(...xs.map((x) => x * 2), 5));
console.log(Math.min(7, ...xs), Math.min(...xs, 0.5, ...[2, 9]));
console.log(Math.max(...[], 1), Math.min(...[], ...[]), Math.max(2, ...[]));
console.log(Math.max(...xs, NaN), Math.min(NaN, ...xs));
console.log(Object.is(Math.max(-0, ...[0]), 0), Object.is(Math.min(0, ...[-0]), -0));
const order: string[] = [];
const tagged = (label: string, values: number[]): number[] => {
  order.push(label);
  return values;
};
const one = (label: string, value: number): number => {
  order.push(label);
  return value;
};
console.log(Math.max(one("a", 1), ...tagged("b", [8, 2]), one("c", 3)), order.join(""));
