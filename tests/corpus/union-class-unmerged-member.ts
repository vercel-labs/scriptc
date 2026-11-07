// A union whose members that share a discriminant value are one record,
// beside a member that is in no such class and has the layout one member
// of the class has on its own. A value of that member's type enters the
// union as the object it is: its discriminant names its own arm.
type Leaf = { kind: "node"; id: string };
type Branch = { kind: "node"; id: string; parent: string };
type Mark = { kind: "mark"; id: string };
type Item = Leaf | Branch | Mark;

function describe(item: Item): string {
  if (item.kind === "mark") return "mark " + item.id;
  return "parent" in item ? "branch " + item.id + " of " + item.parent : "leaf " + item.id;
}

const mark: Mark = { kind: "mark", id: "m1" };
const item: Item = mark;
console.log(describe(item));
console.log((item as unknown) === (mark as unknown));
mark.id = "m2";
console.log(JSON.stringify(item));

// Through an array, beside both members of the class.
const list: Item[] = [];
list.push(mark);
const leaf: Leaf = { kind: "node", id: "l1" };
list.push(leaf);
const branch: Branch = { kind: "node", id: "b1", parent: "l1" };
list.push(branch);
for (const entry of list) console.log(describe(entry));
console.log(list[0] === mark, list[1] === leaf, list[2] === branch);

// Out of a wider union, and as a field.
function pick(n: number): Mark | undefined {
  return n > 0 ? mark : undefined;
}
const picked = pick(process.argv.length);
if (picked) {
  const again: Item = picked;
  console.log(describe(again), (again as unknown) === (mark as unknown));
}
const holder: { item: Item; count: number } = { item: mark, count: 1 };
holder.item.id = "m3";
console.log(mark.id, holder.count);

// A value whose type is inferred, with the discriminant of the member that
// is in no class.
const inferred = { kind: "mark" as const, id: "m4" };
const fromInferred: Item = inferred;
inferred.id = "m5";
console.log(describe(fromInferred));

// The same union read back from JSON and from an untyped value.
const parsed = JSON.parse('[{"kind":"mark","id":"j1"},{"kind":"node","id":"j2"},{"kind":"node","id":"j3","parent":"j2"}]') as Item[];
for (const entry of parsed) console.log(describe(entry));
const boxed: unknown = mark;
console.log(describe(boxed as Item));
