// An EMPTY array literal in a union of array slots (`content: TextContent[] |
// ImageContent[]`, `string[] | number[]`). tsc types the literal `never[]`, an
// element with no representation of its own: the literal used to lower as
// never's f64-element array (`number[]`) and the slot's retag threw
// "a 'number[]' value is not representable in the target union". An empty
// array is the same value whichever array family stores it, so the literal is
// built as the union's first array arm — the rule a lone array slot states —
// and every shape below reaches Node's answer.
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; url: string };
interface Message {
  role: string;
  content: TextContent[] | ImageContent[];
}

// A nested record field: the reported shape.
const empty: Message = { role: "user", content: [] };
console.log(JSON.stringify(empty));

// A declaration, its initialization and a later reassignment.
let wide: string[] | number[] = [];
console.log(JSON.stringify(wide));
wide = [1, 2];
console.log(JSON.stringify(wide));
wide = [];
console.log(JSON.stringify(wide));

// A declared return, a ternary arm, and an async promise's payload.
function none(): string[] | number[] {
  return [];
}
console.log(JSON.stringify(none()), none() !== none());

function either(take: boolean): string[] | number[] {
  return take ? [] : [1, 2];
}
console.log(JSON.stringify(either(true)), JSON.stringify(either(false)));

function bothWays(): string[] | number[] {
  return false ? [] : [];
}
console.log(JSON.stringify(bothWays()));

async function settled(): Promise<string[] | number[]> {
  return [];
}
void settled().then((value) => console.log("settled", JSON.stringify(value)));

// An argument slot, and a default parameter that is itself the slot.
function report(label: string, value: string[] | number[]): void {
  console.log(label, JSON.stringify(value));
}
report("argument", []);
report("argument-filled", ["x"]);

function withDefault(value: string[] | number[] = []): void {
  console.log("default", JSON.stringify(value));
}
withDefault();
withDefault([3]);

// Deeper nesting, a class field, and a discriminated record's field.
interface Nested {
  inner: { list: readonly string[] | readonly number[]; tag: string };
}
const nested: Nested = { inner: { list: [], tag: "t" } };
console.log(JSON.stringify(nested));

class Store {
  lists: string[] | number[] = [];
}
const store = new Store();
console.log("class", JSON.stringify(store.lists), store.lists !== undefined);

// An optional arm (`| undefined`) keeps the empty literal on its array arm.
const maybe: string[] | number[] | undefined = [];
console.log("maybe", maybe !== undefined, JSON.stringify(maybe));

// The empty literal as an element of an array, and through collections whose
// element slot is the union.
const rows: (string[] | number[])[] = [[], [1, 2], []];
console.log("rows", JSON.stringify(rows));
const grouped = new Set<string[] | number[]>();
grouped.add([]);
grouped.add(["s"]);
console.log("set", JSON.stringify([...grouped]));
const byKey = new Map<string, string[] | number[]>();
byKey.set("a", []);
byKey.set("b", [7]);
console.log("map", JSON.stringify([...byKey.entries()]));

// A callback argument, and the assertion form of the same value.
function apply(fn: (value: string[] | number[]) => string): string {
  return fn([]);
}
console.log("callback", apply((value) => JSON.stringify(value)));
const asserted = { role: "tool", content: [] } as Message;
console.log("asserted", JSON.stringify(asserted));

// Every evaluation builds a fresh empty array, as Node does.
function fresh(): string[] | number[] {
  return [];
}
const first = fresh();
const second = fresh();
console.log("fresh", first !== second, JSON.stringify(first), JSON.stringify(second));
