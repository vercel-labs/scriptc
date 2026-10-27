// Assignment, update and for-of targets wrapped in parentheses or non-null
// assertions write the reference inside them, as in JavaScript, and the
// writes count for every analysis of the binding or member they write.
const h = { sums: [1, 2, 3] };
const k = 1;
h.sums[k]! += 10;
console.log(h.sums.join(","));
let x = 1;
(x) = 2;
console.log(x);
let y: number | undefined = 1;
y! = 5;
console.log(y);
const a = [1, 2];
(a[0]) += 1;
a[1]! = 7;
a[0]!++;
++(a[1]!);
console.log(a.join(","));
const o: { n?: number } = { n: 1 };
o.n! = 4;
(o.n)! *= 2;
console.log(o.n);
let counter = 0;
for ((counter) of [3, 4]) {}
console.log(counter);
const m = new Map<string, number[]>([["a", [1]]]);
m.get("a")![0]! += 4;
console.log(m.get("a")!.join(","));
const r = (a[0]! += 2);
console.log(r, a[0]);
let limit = 3;
function bump(): void {
  (limit) = 9;
}
bump();
console.log(limit);
class Counter {
  count: number | undefined = 0;
  readonly fixed = 1;
  inc(): void {
    this.count! += 1;
    (this.count)!++;
  }
}
const c = new Counter();
c.inc();
console.log(c.count, c.fixed);
let flag = false;
const set = (): void => {
  flag! = true;
};
set();
console.log(flag);
