// An untyped value that reaches a typed slot without an assertion stays one
// object with the typed value only where every object it holds can be the
// one built in its place. Where one cannot (the same object stored twice, a
// child that is not plain data, a class instance, a sparse array, the values
// of an index signature), the slot takes a copy and the source stays as it
// was. Every line reads the source through its untyped names; the last block
// is a tree of plain data, which is one object on both sides.

type R = { x: number };

// The same object twice in an array, with a holder outside.
const twice: any = { x: 1 };
const pair: any = [twice, twice];
const typedPair: R[] = pair;
pair[1].x = 8;
console.log("array, twice:", twice.x, pair[0].x, pair[1].x, pair[0] === twice, pair[1] === twice);
console.log("  typed length:", typedPair.length);

// The same object in two fields of a record.
const both: any = { x: 1 };
const fields: any = { a: both, b: both };
const typedFields: { a: R; b: R } = fields;
fields.b.x = 9;
console.log("record, twice:", both.x, fields.a.x, fields.b.x, fields.a === fields.b);
console.log("  typed field:", typeof typedFields.a.x);

// The same object in two nested arrays.
const deep: any = { x: 1 };
const lists: any = { a: [deep], b: [deep] };
const typedLists: { a: R[]; b: R[] } = lists;
lists.b[0].x = 8;
console.log("nested, twice:", deep.x, lists.a[0].x, lists.b[0].x, lists.a[0] === lists.b[0]);
console.log("  typed length:", typedLists.a.length);

// The same object twice in a tuple.
const inTuple: any = { x: 1 };
const tuple: any = [inTuple, inTuple];
const typedTuple: [R, R] = tuple;
tuple[1].x = 8;
console.log("tuple, twice:", inTuple.x, tuple[0].x, tuple[1].x, tuple[0] === tuple[1]);
console.log("  typed length:", typedTuple.length);

// A child with an accessor property.
function withAccessor(): any {
  const child: any = {};
  let hits = 0;
  Object.defineProperty(child, "x", {
    get() {
      hits++;
      return hits;
    },
    enumerable: true,
    configurable: true,
  });
  return { c: child, n: 1 };
}
const accessorSource: any = withAccessor();
const typedAccessor: { c: R; n: number } = accessorSource;
console.log(
  "accessor child:",
  typeof Object.getOwnPropertyDescriptor(accessorSource.c, "x")!.get,
  accessorSource.c.x < accessorSource.c.x,
);
console.log("  typed field:", typeof typedAccessor.n);

// A frozen child and a child with a symbol key, each with a holder outside.
const frozen: any = Object.freeze({ x: 1 });
const keyed: any = { x: 2 };
const key = Symbol("k");
keyed[key] = 3;
const special: any = { f: frozen, s: keyed, n: 1 };
const typedSpecial: { f: R; s: R; n: number } = special;
console.log(
  "frozen and symbol-keyed children:",
  Object.isFrozen(special.f),
  special.f === frozen,
  special.s === keyed,
  special.s[key],
);
console.log("  typed field:", typedSpecial.n);

// A child that is a class instance, in a record's slot.
class Counter {
  x = 1;
  bump(): void {
    this.x++;
  }
}
const counter = new Counter();
const holder: any = { c: counter, n: 1 };
const typedHolder: { c: R; n: number } = holder;
counter.bump();
console.log("class instance child:", holder.c.x, holder.c instanceof Counter);
console.log("  typed field:", typedHolder.n);

// A sparse array whose element has a holder outside.
const element: any = { x: 1 };
const sparse: any = [element];
sparse[3] = element;
const typedSparse: (R | undefined)[] = sparse;
element.x = 5;
console.log("sparse array:", sparse[0].x, sparse[3].x, sparse[0] === element);
console.log("  typed length:", typedSparse.length);

// The value of an index signature, with a holder outside.
const value: any = { x: 1 };
const byKey: any = { a: value };
const typedByKey: { [k: string]: R } = byKey;
value.x = 5;
console.log("index signature:", byKey.a.x, byKey.a === value);
console.log("  typed keys:", Object.keys(typedByKey).length);

// A tree of plain data, every object stored once: one object on both sides.
const leaf: any = { x: 1 };
const list: any = [leaf, { x: 2 }];
const tree: any = { list: list, head: { x: 3 }, nums: [1, 2, 3], n: 1 };
const typedTree: { list: R[]; head: R; nums: number[]; n: number } = tree;
leaf.x = 5;
list.push({ x: 4 });
typedTree.head.x = 7;
console.log("a tree:", tree.list[0].x, tree.list === list, tree.list.length, tree.head.x);
console.log("  typed side:", typedTree.list.length, typedTree.list[0].x);
