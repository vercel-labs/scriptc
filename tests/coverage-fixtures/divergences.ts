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

// Key order: the literal's order differs from the declaration and the
// program observes it.
interface Point {
  x: number;
  y: number;
}
const point: Point = { y: 1, x: 2 };
console.log(JSON.stringify(point));

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

// The native date parser takes ISO 8601 with an explicit offset.
console.log(Date.parse("Jan 2, 2024"), new Date("2024/01/02").getTime(), Date.parse("2024-01-02T03:04:05Z"));
const stamps = ["2024-03-04T05:06:07Z", "March 4, 2024"];
for (const stamp of stamps) console.log(Date.parse(stamp));
