function score(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i % 3 === 0 ? 2 : 1;
  }
  return total;
}
const items = [1, 2, 3];
const handler = (x: number) => x * 2;

const anyone: unknown = score(1);
const flags = anyone == score(2); // unknown/object coercion keeps the fence; static primitive pairs lower
const { length: firstItem } = score(3) > 99 ? items : "abc"; // a union source keeps the object-pattern fence (narrow first)
let label = "score: ";
label += score(10);
console.log(label);
console.log(items.length, handler(2));
