// A union flowing whole into a record slot that is one of its own arms, with
// no promise involved: the other arm is a value of the slot's type too (it has
// the members, with types the slot accepts), so the slot takes it. A return,
// an assignment, an argument, a member and an element.
interface Item {
  text: string;
  detail?: string | number;
}
type Exact = { text: string; detail: string };

function asItem(value: Exact | Item): Item {
  return value;
}
function describe(item: Item): string {
  return `${item.text} ${typeof item.detail} ${item.detail} ${"detail" in item} ${JSON.stringify(item)}`;
}
function pass(value: Exact | Item): string {
  return describe(value);
}
function memberOf(holder: { value: Exact | Item }): { value: Item } {
  return holder;
}
function elementsOf(values: (Exact | Item)[]): Item[] {
  return values;
}
// A unit arm the checker narrowed away sits beside them.
function present(value: Exact | Item | undefined): Item {
  if (value === undefined) throw new Error("nothing");
  return value;
}
// A class instance beside the record it satisfies.
class Line {
  text: string;
  detail: number;
  constructor(text: string) {
    this.text = text;
    this.detail = text.length;
  }
}
function lineItem(value: Line | Item): Item {
  return value;
}

const exact: Exact = { text: "exact", detail: "d" };
const item: Item = { text: "item" };
const numbered: Item = { text: "numbered", detail: 3 };

console.log("return", describe(asItem(exact)), describe(asItem(item)), describe(asItem(numbered)));
const either: Exact | Item = exact.text.length > 3 ? exact : item;
const assigned: Item = either;
console.log("assign", describe(assigned));
console.log("argument", pass(exact), pass(item));
console.log("member", describe(memberOf({ value: exact }).value), describe(memberOf({ value: numbered }).value));
console.log("elements", elementsOf([exact, item, numbered]).map(describe).join(" | "));
console.log("present", describe(present(exact)), describe(present(item)));
try {
  present(undefined);
} catch (error) {
  console.log("present", (error as Error).message);
}
console.log("class", lineItem(new Line("line")).text, lineItem(new Line("line")).detail, lineItem(item).text);
