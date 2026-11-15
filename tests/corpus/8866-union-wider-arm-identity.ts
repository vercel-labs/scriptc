// A union of two record types where one is the other plus optional fields,
// and no discriminant. A value of the narrower type that travels as `unknown`
// and is checked into the union is its own arm, the same object. Before, the
// wider arm was tried first, accepted a copy of the record (its extra fields
// are optional), and the conversion returned that copy: a write through the
// union value never reached the record, and a later write to the record
// never reached the union value, with no diagnostic.
type Point = { x: number; name: string };
type Noted = { x: number; name: string; note?: string };
type Tagged = { x: number; name: string; note?: string; tags?: string[] };

const point: Point = { x: 1, name: "p" };
const held: unknown = point;

// Two arms.
const either = held as Point | Noted;
either.x = 5;
console.log("write through the union value:", point.x);
point.x = 6;
console.log("write to the record:", either.x);
console.log("note" in either, JSON.stringify(either), Object.keys(either).join(","));

// Three arms of growing width.
const any = held as Point | Noted | Tagged;
any.name = "renamed";
console.log("three arms:", point.name, "tags" in any, "note" in any);

// The value really is a wider arm: that arm, and still the same object.
const noted: Noted = { x: 10, name: "n", note: "kept" };
const heldNoted: unknown = noted;
const wider = heldNoted as Point | Noted;
wider.x = wider.x + 1;
console.log("wider value:", noted.x, "note" in wider ? wider.note : "none", JSON.stringify(wider));
const bare: Noted = { x: 20, name: "b" };
const heldBare: unknown = bare;
const absent = heldBare as Point | Noted;
absent.x = absent.x + 1;
if ("note" in absent) absent.note = "added";
console.log("wider value without its optional field:", bare.x, JSON.stringify(bare));

// Through a function that takes the union, and in an array of it.
function bump(value: Point | Noted): number {
	value.x = value.x + 100;
	return value.x;
}
console.log("argument:", bump(held as Point | Noted), point.x);
const many: unknown[] = [point, noted, bare];
const list = many as (Point | Noted)[];
for (const item of list) item.x = -item.x;
console.log("array:", point.x, noted.x, bare.x, JSON.stringify(list));

// An optional union field of a record that is checked as a whole.
type Holder = { item?: Point | Noted; count: number };
const holder = { item: point, count: 1 };
const heldHolder: unknown = holder;
const checked = heldHolder as Holder;
if (checked.item !== undefined) checked.item.x = 7;
console.log("field of a checked record:", point.x, holder.item.x);
