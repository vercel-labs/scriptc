// The members of a union that share a discriminant literal are stored as one record, and a value of
// one member's own type is that record: it enters the union, leaves it and is narrowed inside it as
// the same object. Writes through any of its names reach it, and `===` holds.
type Leaf = { kind: "node"; id: string };
type Branch = { kind: "node"; id: string; parent: string };
type Count = { kind: "count"; n: number };
type Item = Leaf | Branch | Count;

function show(u: Item): void {
  console.log(JSON.stringify(u), Object.keys(u).join(","), "parent" in u);
}
show({ kind: "node", id: "i" });
show({ kind: "node", id: "i", parent: "p" });
show({ kind: "count", n: 1 });

const leaf: Leaf = { kind: "node", id: "a" };
const branch: Branch = { kind: "node", id: "b", parent: "q" };
show(leaf);
show(branch);

// Stored in the union's type and read back.
const list: Item[] = [leaf, branch, { kind: "count", n: 2 }];
console.log(list[0] === leaf, list[1] === branch, list.indexOf(branch));
leaf.id = "changed";
console.log(JSON.stringify(list[0]));
function widen(x: Leaf): Item {
  return x;
}
console.log(widen(leaf) === leaf);

// Narrowed back to a member and written through.
function asBranch(u: Item): Branch | undefined {
  return u.kind === "node" && "parent" in u ? u : undefined;
}
const back = asBranch(list[1]!);
console.log(back === branch, back?.parent);
if (back) back.parent = "w";
console.log(JSON.stringify(branch), JSON.stringify(list[1]));
function rename(b: Branch, to: string): void {
  b.id = to;
}
const second = list[1]!;
if (second.kind === "node" && "parent" in second) rename(second, "renamed");
console.log(branch.id);

// A member's own members, destructured and spread.
const { id, parent } = branch;
console.log(id, parent);
const copy: Branch = { ...branch, parent: "other" };
console.log(JSON.stringify(copy), JSON.stringify(branch), copy === branch);
const fromLeaf: Branch = { ...leaf, parent: "added" };
console.log(JSON.stringify(fromLeaf), Object.keys(fromLeaf).join(","));

// A set and a map keyed by the object.
const marks = new Set<Item>([leaf]);
console.log(marks.has(list[0]!), marks.has(branch));
const names = new Map<Item, string>([[branch, "branch"]]);
console.log(names.get(list[1]!));

// A value asserted past its members: reading the member it lacks throws in both worlds.
const lying = leaf as Item as Branch;
try {
  console.log(lying.parent.length);
} catch (e) {
  console.log("caught", e instanceof TypeError);
}

// Through `unknown` and through JSON.
const boxed: unknown = branch;
const again = boxed as Item;
console.log(again === branch, again.kind === "node" && "parent" in again ? again.parent : "-");
const parsed = JSON.parse('[{"kind":"node","id":"x"},{"kind":"node","id":"y","parent":"x"},{"kind":"count","n":3}]') as Item[];
for (const p of parsed) show(p);
