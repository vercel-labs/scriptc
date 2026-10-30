// Records that keep undeclared own keys (a width spread, a checked
// JSON.parse) answer every reflective surface from those keys: for-in, `in`,
// hasOwnProperty, Object.hasOwn, Object.entries/values, Object.assign, and
// further spreads and clones of the same shape.

type Narrow = { a: number; b?: string };
type Wide = { a: number; b?: string; extra: string; tag: string };

const wide: Wide = { a: 1, extra: "x", tag: "t", b: "bee" };
const spread: Narrow = { ...wide };
const parsed = JSON.parse('{"a":1,"extra":"x","tag":"t","b":"bee"}') as Narrow;

function reflect(label: string, r: Narrow): void {
  const keys: string[] = [];
  for (const k in r) keys.push(k);
  console.log(label, "for-in", keys.join(","));
  console.log(label, "in", "extra" in r, "missing" in r, "a" in r);
  console.log(
    label,
    "own",
    Object.prototype.hasOwnProperty.call(r, "extra"),
    Object.hasOwn(r, "tag"),
    Object.hasOwn(r, "missing"),
  );
  console.log(label, "entries", JSON.stringify(Object.entries(r)));
  console.log(label, "values", JSON.stringify(Object.values(r)));
  console.log(label, "assign", JSON.stringify(Object.assign({}, r)));
  const same: Narrow = { ...r };
  console.log(label, "copy", JSON.stringify(same));
  const clone: Narrow = { ...r, a: 2 };
  console.log(label, "clone", JSON.stringify(clone), Object.keys(clone).join(","));
}
reflect("spread", spread);
reflect("parsed", parsed);

// A record without undeclared keys answers from its declared fields.
reflect("plain", { a: 3 });

// A width spread observed only through a later spread that adds a field.
type Point = { x: number };
type Point3 = { x: number; y: number; z: number };
const toPoint = (p: Point3): Point => ({ ...p });
console.log("through spread", JSON.stringify({ ...toPoint({ x: 1, y: 2, z: 3 }), w: 4 }));

// A width spread observed only by presence tests.
type Tag = { id: number };
type Tagged = { id: number; label: string };
const toTag = (t: Tagged): Tag => ({ ...t });
const tag = toTag({ id: 7, label: "seven" });
console.log("presence", "label" in tag, Object.hasOwn(tag, "label"), Object.hasOwn(tag, "other"));

// A same-shape spread of a record nested in a checked conversion.
type Leaf = { v: number };
type Tree = { leaf: Leaf };
const tree = JSON.parse('{"leaf":{"v":1,"extra":2}}') as Tree;
const leafCopy: Leaf = { ...tree.leaf };
console.log("nested copy", JSON.stringify(leafCopy));
