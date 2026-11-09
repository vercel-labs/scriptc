// The identity dictionary in each position a union can hold it.
interface Bag { [key: string]: Item }
type Item = number | Item[] | Bag;
type Tree = string | { [key: string]: Tree };
type Maybe = undefined | Named | boolean;
type Named = { [key: string]: Maybe };
type Outer = null | string | OuterDict;
type OuterDict = { [key: string]: Inner };
type Inner = { [key: string]: Outer };

const bagSource = { n: 1 };
const bag: Bag = bagSource;
bag.more = [2, { deep: 3 }];
const item: Item = bag;
const items: Item = [1, bag, [bag]];
console.log(JSON.stringify(item), JSON.stringify(items), item === bag, JSON.stringify(bagSource));
function count(value: Item): number {
  if (typeof value === "number") return 1;
  if (Array.isArray(value)) {
    let total = 0;
    for (const each of value) total += count(each);
    return total;
  }
  let sum = 0;
  for (const key of Object.keys(value)) sum += count(value[key] ?? 0);
  return sum;
}
console.log(count(item), count(items), count(5), count({ a: [1, 2], b: { c: 3 } }));

const treeSource = { leaf: "l" };
const tree: { [key: string]: Tree } = treeSource;
tree.branch = { twig: "t" };
const root: Tree = tree;
const parsedTree = JSON.parse('{"x":{"y":"z"},"w":"v"}') as Tree;
function leaves(value: Tree): string[] {
  if (typeof value === "string") return [value];
  return Object.keys(value).flatMap((key) => leaves(value[key] ?? ""));
}
console.log(JSON.stringify(root), leaves(root).join(","), leaves(parsedTree).join(","), leaves("solo").join(","), JSON.stringify(treeSource));

const namedSource = { flag: true };
const named: Named = namedSource;
named.gone = undefined;
named.inner = { deep: false };
const maybe: Maybe = named;
function show(value: Maybe): string {
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return String(value);
  return `{${Object.keys(value).map((key) => `${key}:${show(value[key])}`).join(",")}}`;
}
console.log(show(maybe), show(undefined), show(false), show({ a: { b: true } }), Object.keys(namedSource).join(","));

const outerSource = { first: { a: "x" } };
const outerDict: OuterDict = outerSource;
outerDict.second = { b: null, c: { d: { e: "deep" } } };
const outerValue: Outer = outerDict;
console.log(JSON.stringify(outerValue), JSON.stringify(outerSource), outerValue === outerDict);
