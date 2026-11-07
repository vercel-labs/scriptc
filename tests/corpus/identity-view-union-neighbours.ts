// What sits beside a dictionary that keeps identity in a recursive union: a fixed record arm
// and an existing typed array or record that enters the union. And the same union over a
// dictionary with a symbol-keyed member, which is checked-dynamic without any identity.
type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };
const fixed = { a: 1 };
const dict: JsonObject = fixed;
dict.z = true;

const nums: number[] = [1, 2];
const viaNums: Json = nums;
nums.push(3);
const point = { x: 1, y: 2 };
const viaPoint: Json = point;
point.x = 9;
console.log(JSON.stringify(viaNums), JSON.stringify(viaPoint), viaNums === (nums as Json), viaPoint === (point as Json));

type Leaf = { label: string; count: number };
type Bag = { [key: string]: Node };
type Node = Leaf | Node[] | Bag;
const bagSource = { first: { label: "f", count: 1 } };
const bag: Bag = bagSource;
bag.more = [{ label: "m", count: 2 }];
const leaf: Leaf = { label: "x", count: 0 };
const node: Node = leaf;
leaf.count = 5;
const nodes: Node = [leaf, bag];
leaf.count = 6;
console.log(JSON.stringify(node), JSON.stringify(nodes), JSON.stringify(bag), node === leaf, JSON.stringify(bagSource));

interface Tagged {
  [key: string]: Value;
  [Symbol.toStringTag]: string;
}
type Value = number | Value[] | Tagged;
const tagged: Tagged = { a: 1, [Symbol.toStringTag]: "T" };
tagged.b = [2, { c: 3, [Symbol.toStringTag]: "U" }];
const value: Value = tagged;
const many: Value = [1, tagged, [2]];
const literal: Value = { d: 4, [Symbol.toStringTag]: "L" };
console.log(JSON.stringify(value), JSON.stringify(many), JSON.stringify(literal), String(tagged), value === tagged);
