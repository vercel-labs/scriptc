// An object literal's `files: []` has no element type of its own (the
// checker types it `never[]`) and may flow into any typed array slot. It is
// one array under every name: a write through a typed name is visible
// through the object, through every other name, and in the array's identity.

interface Item {
  name: string;
}

function addTo(list: string[], value: string): void {
  list.push(value);
}

class Sink {
  add(list: string[], value: string): void {
    list.push(value);
  }
}

function id<T>(value: T): T {
  return value;
}

// An annotated binding.
{
  const o = { files: [] };
  const f: string[] = o.files;
  f.push("x");
  console.log("const", o.files.length, f.length, o.files === f, JSON.stringify(o));
}

// A parameter: a function, a method, a callback.
{
  const o = { files: [] };
  addTo(o.files, "x");
  new Sink().add(o.files, "y");
  const each = (fn: (list: string[]) => void): void => fn(o.files);
  each((list) => list.push("z"));
  console.log("parameter", o.files.length, o.files.join(","));
}

// A typed field: in a literal, and written later.
{
  const o = { files: [] };
  const held: { list: string[] } = { list: o.files };
  held.list.push("x");
  const later: { list: string[] } = { list: ["seed"] };
  later.list = o.files;
  later.list.push("y");
  console.log("field", o.files.length, held.list === o.files, later.list === o.files);
}

// Destructuring, annotated and not.
{
  const o = { files: [] };
  const { files }: { files: string[] } = o;
  files.push("x");
  const { files: again } = o;
  const typed: string[] = again;
  typed.push("y");
  console.log("destructuring", o.files.length, files === o.files, again === o.files);
}

// A typed function result, and an explicit generic instance.
{
  const o = { files: [] };
  const list = (): string[] => o.files;
  list().push("x");
  const through = id<string[]>(o.files);
  through.push("y");
  console.log("result", o.files.length, list() === o.files, through === o.files);
}

// A union slot, a readonly slot, an element of an array of arrays, a Map value.
{
  const o = { files: [] };
  const maybe: string[] | undefined = o.files;
  if (maybe) maybe.push("x");
  const frozen: readonly string[] = o.files;
  const all: string[][] = [o.files];
  all[0]!.push("y");
  const byKey = new Map<string, string[]>();
  byKey.set("k", o.files);
  byKey.get("k")!.push("z");
  console.log("slots", o.files.length, frozen === o.files, all[0] === o.files, byKey.get("k") === o.files);
}

// The whole object where its type is declared, and a spread copy of it.
{
  const o = { files: [] };
  const state: { files: string[] } = o;
  state.files.push("x");
  const copy = { ...o, extra: 1 };
  const fromCopy: string[] = copy.files;
  fromCopy.push("y");
  console.log("object", o.files.length, state.files === o.files, copy.files === o.files, copy.extra);
}

// A closure that takes the typed name on every call.
{
  const o = { files: [] };
  const add = (value: string): number => {
    const f: string[] = o.files;
    f.push(value);
    return f.length;
  };
  console.log("closure", add("x"), add("y"), o.files.length);
}

// Other element types: numbers, records, optional elements; two fields.
{
  const o = { sizes: [], items: [], names: [] };
  const sizes: number[] = o.sizes;
  sizes.push(1, 2);
  const items: Item[] = o.items;
  items.push({ name: "x" });
  const names: (string | undefined)[] = o.names;
  names.push("n", undefined);
  console.log("elements", JSON.stringify(o), o.names.length, o.sizes === sizes, o.items === items);
}

// Reads through the first name after writes through the second.
{
  const o = { files: [] };
  const f: string[] = o.files;
  f.push("x", "y");
  console.log(o.files);
  const seen: string[] = [];
  for (const value of o.files) addTo(seen, value);
  o.files.forEach((value) => addTo(seen, value));
  console.log("reads", JSON.stringify(o), o.files.join("+"), o.files.length, seen.join(""));
  const first: string = o.files[0]!;
  console.log("index", first, o.files.slice(1).length, o.files.filter(() => true).length);
}

// Writes through the first name are visible through the second.
{
  const o = { files: [] };
  const f: string[] = o.files;
  f.push("x", "y", "z");
  o.files.length = 2;
  console.log("length", o.files.length, f.length);
  o.files.pop();
  console.log("pop", o.files.length, f.length, f.join(","));
}

// Identity.
{
  const o = { files: [] };
  const f: string[] = o.files;
  const g: string[] = o.files;
  console.log("identity", o.files === f, f === g, [f].includes(g), [f].indexOf(g), new Set([f, g]).size);
}

// A nested field, a field of an array's element, a field of a function's
// result, and a binding assigned twice.
{
  const nested = { inner: { files: [] } };
  const a: string[] = nested.inner.files;
  a.push("x");
  const rows = [{ files: [] }];
  const b: string[] = rows[0]!.files;
  b.push("y");
  const fresh = () => ({ files: [] });
  const made = fresh();
  const c: string[] = made.files;
  c.push("z");
  let again = { files: [] };
  again = { files: [] };
  const d: string[] = again.files;
  d.push("w");
  console.log("holders", JSON.stringify(nested), JSON.stringify(rows), made.files.length, again.files.length);
}

// A class field that holds the record.
class Store {
  state = { files: [], count: 0 };
  add(value: string): void {
    const list: string[] = this.state.files;
    list.push(value);
    this.state.count += 1;
  }
}
{
  const store = new Store();
  store.add("x");
  store.add("y");
  console.log("class field", store.state.files.length, store.state.count);
}

// A generic body: each instance has its own array, of its own element
// type, also where the type parameter is inside the element.
function collect<T>(first: T): { rows: { value: T }[]; plain: T[] } {
  const o = { rows: [], plain: [] };
  const rows: { value: T }[] = o.rows;
  rows.push({ value: first });
  const plain: T[] = o.plain;
  plain.push(first);
  return o;
}
console.log(
  "generic",
  JSON.stringify(collect("s")),
  JSON.stringify(collect(1)),
  JSON.stringify(collect({ k: true })),
);

// No typed name at all: the array stays empty and is still one array.
{
  const o = { files: [] };
  const alias = o.files;
  const list = () => o.files;
  console.log("untyped", o.files.length, alias === o.files, list() === o.files, [...o.files].length, JSON.stringify(o));
}
