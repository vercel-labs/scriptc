// Programs that compile but behave differently natively than under Node:
// each site below is reported as a divergence warning.
interface Labeled {
  label: string;
}
interface Tagged {
  label: string;
  tag: string;
}

// A narrower record parameter is a field copy: the write is lost.
function relabel(target: Labeled): void {
  target.label = "renamed";
}
const tagged: Tagged = { label: "first", tag: "t" };
relabel(tagged);
console.log(tagged.label);

// A narrower binding is a copy too: identity comparison is false.
const view: Labeled = tagged;
console.log(view === tagged);

// Key order: values of one type are built in two orders, and a spread sets
// an optional key its source lacks, so the values cannot record their own
// orders and the type keeps its declaration order.
interface Point {
  x: number;
  y: number;
  label?: string;
}
const point: Point = { y: 1, x: 2 };
const other: Point = { x: 3, y: 4 };
const labeled: Point = { ...point, label: "p" };
console.log(JSON.stringify(point), JSON.stringify(other), JSON.stringify(labeled));

// Text outside the built-in collation compares by code point natively.
console.log(["б", "а"].sort((p, q) => p.localeCompare(q)).join(","), "яблоко".localeCompare("груша"));

// A call feeds an instance to a cast to an unrelated class.
class Shape {
  sides = 0;
}
class Square extends Shape {
  size = 2;
}
class Circle extends Shape {
  size = 3;
}
function sizeOf(s: Shape): number {
  return (s as Square).size;
}
console.log(sizeOf(new Circle()));

// Date strings parse with V8's grammar natively, so none of these diverge.
console.log(Date.parse("Jan 2, 2024"), new Date("2024/01/02").getTime(), Date.parse("2024-01-02T03:04:05Z"));
const stamps = ["2024-03-04T05:06:07Z", "March 4, 2024"];
for (const stamp of stamps) console.log(Date.parse(stamp));
