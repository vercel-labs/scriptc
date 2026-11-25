// `delete` of a key the operand's type does not declare removes it from the
// record's kept source (tests/corpus/8998-delete-undeclared-record-key.ts).
// That is Node's delete only while the operand is the one record the object
// has. A narrowing conversion and a checked conversion of a boxed record
// both give the object a second record; when the wider record's type
// declares the key, the property is that record's field, which the delete
// cannot reach through the narrower type. It would answer `true` and leave
// `wide.k` in place, so each form refuses by name.
type Wide = { x: number; k: number };
type Narrow = { x: number };

// A narrowed copy: `copy` is a second record built from `wide`.
const wide: Wide = { x: 1, k: 2 };
const copy: Narrow = wide;
console.log(delete (copy as Narrow & { k?: number }).k, wide.k);

// A copy of a copy: `Wider` declares the key two conversions away.
type Wider = { x: number; y: number; q: number };
type Middle = { x: number; y: number };
type Least = { x: number };
const wider: Wider = { x: 1, y: 2, q: 3 };
const middle: Middle = wider;
const least: Least = middle;
delete (least as Least & { q?: number }).q;
console.log(wider.q, middle.y);

// A checked conversion of a boxed record: `view` is `boxedWide`'s storage
// under a narrower type.
type BoxedWide = { name: string; k: number };
type Viewed = { name: string };
const boxedWide: BoxedWide = { name: "n", k: 2 };
const untyped: unknown = boxedWide;
const view = untyped as Viewed;
delete (view as Viewed & { k?: number }).k;
console.log(boxedWide.k, view.name);

// The same when the boxed record was parsed and keeps a source of its own:
// `extra` is in that kept source, but `k` is the wide record's field.
type ParsedWide = { id: string; k: number };
type ParsedView = { id: string };
const parsedWide = JSON.parse('{"id":"a","k":2,"extra":3}') as ParsedWide;
const reboxed: unknown = parsedWide;
const parsedView = reboxed as ParsedView;
delete (parsedView as ParsedView & { k?: number }).k;
console.log(parsedWide.k, parsedView.id);
