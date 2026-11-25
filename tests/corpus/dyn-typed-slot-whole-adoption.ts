// An untyped value that reaches a typed slot without an assertion stays one
// object with the typed value only where every object it holds can be the
// one built in its place. Where one cannot (the same object stored twice, a
// child that is not plain data, a class instance, a sparse array, the values
// of an index signature), the slot takes a copy and the source stays as it
// was. Every line reads the source through its untyped names; the last two
// blocks are trees of plain data, which are one object on both sides.

type R = { x: number };
type Two = { a: R; b: R };

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
const typedFields: Two = fields;
fields.b.x = 9;
console.log("record, twice:", both.x, fields.a.x, fields.b.x, fields.a === fields.b);
console.log("  typed field:", typeof typedFields.a.x);

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
  return { a: child, b: { x: 0 } };
}
const accessorSource: any = withAccessor();
const typedAccessor: Two = accessorSource;
console.log(
  "accessor child:",
  typeof Object.getOwnPropertyDescriptor(accessorSource.a, "x")!.get,
  accessorSource.a.x < accessorSource.a.x,
);
console.log("  typed field:", typeof typedAccessor.b.x);

// A frozen child and a child with a symbol key, each with a holder outside.
const frozen: any = Object.freeze({ x: 1 });
const keyed: any = { x: 2 };
const key = Symbol("k");
keyed[key] = 3;
const special: any = { a: frozen, b: keyed };
const typedSpecial: Two = special;
console.log(
  "frozen and symbol-keyed children:",
  Object.isFrozen(special.a),
  special.a === frozen,
  special.b === keyed,
  special.b[key],
);
console.log("  typed field:", typedSpecial.b.x);

// A child that is a class instance, in a record's slot.
class Counter {
  x = 1;
  bump(): void {
    this.x++;
  }
}
const counter = new Counter();
const holder: any = { a: counter, b: { x: 0 } };
const typedHolder: Two = holder;
counter.bump();
console.log("class instance child:", holder.a.x, holder.a instanceof Counter);
console.log("  typed field:", typedHolder.b.x);

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

// A record of plain data, every object stored once: one object on both sides.
const leaf: any = { x: 1 };
const tree: any = { a: leaf, b: { x: 3 } };
const typedTree: Two = tree;
leaf.x = 5;
typedTree.b.x = 7;
console.log("a record tree:", tree.a.x, tree.a === leaf, tree.b.x);
console.log("  typed side:", typedTree.a.x);

// An array of plain data, every object stored once.
const first: any = { x: 1 };
const list: any = [first, { x: 2 }];
const typedList: R[] = list;
first.x = 5;
list.push({ x: 4 });
console.log("an array tree:", list[0].x, list[0] === first, list.length);
console.log("  typed side:", typedList.length, typedList[0].x);
