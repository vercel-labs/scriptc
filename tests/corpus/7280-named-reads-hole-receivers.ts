// Named reads and method calls through a parameter narrowed to one arm of a
// wide union, when an array hole reaches the narrowed branch.
type Bag = number | string | number[] | { a?: number; f?: () => string };
function isBag(value: Bag): value is { a?: number; f?: () => string } {
  return !Array.isArray(value) && typeof value !== "string" && typeof value !== "number";
}
function peek(value: Bag): string {
  if (isBag(value)) return typeof value.a;
  return "-";
}
function call(value: Bag): string {
  if (isBag(value)) return value.f?.() ?? "none";
  return "-";
}
class Shape {
  side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
type Item = Shape | string | number;
function area(item: Item): number {
  if (item instanceof Shape || (typeof item !== "string" && typeof item !== "number")) return item.area();
  return 0;
}
const bags: Bag[] = [{ a: 1, f: () => "f" }, "s", [1]];
bags.length = 4;
const items: Item[] = [new Shape(2), "x"];
items.length = 3;
const out: string[] = [];
for (let i = 0; i < bags.length; i++) {
  for (const which of [0, 1]) {
    try {
      out.push(which === 0 ? peek(bags[i]) : call(bags[i]));
    } catch (e) {
      out.push(e instanceof TypeError ? e.message : "other");
    }
  }
}
for (let i = 0; i < items.length; i++) {
  try {
    out.push(String(area(items[i])));
  } catch (e) {
    out.push(e instanceof TypeError ? e.message : "other");
  }
}
console.log(out.join("\n"));
