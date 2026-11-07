// Programs that compile but behave differently natively than under Node:
// each site below is reported as a divergence warning.
interface Labeled {
  label: string;
}
interface Tagged {
  label: string;
  tag: string;
}

// A narrower record parameter of a method is a field copy: the write is lost.
// (A declared function called directly runs on the caller's record instead.)
const labels = {
  relabel(target: Labeled): void {
    target.label = "renamed";
  },
};
const tagged: Tagged = { label: "first", tag: "t" };
labels.relabel(tagged);
console.log(tagged.label);

// A narrower binding is a copy too: identity comparison is false.
const view: Labeled = tagged;
console.log(view === tagged);

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
