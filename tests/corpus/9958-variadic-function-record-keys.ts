// Keyed reads of records whose values are variadic functions (a rest
// parameter, or a held constructor, which reads the arguments it is given):
// a hit is the entry, a miss is undefined, and a miss on a name
// Object.prototype has is that built-in, as in Node.
const tally: Record<string, (...values: unknown[]) => unknown> = {
  count: (...values: unknown[]) => values.length,
  first: (...values: unknown[]) => values[0],
};
const names = ["count", "first", "missing", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
for (const name of names) {
  const entry = tally[name];
  console.log(name, typeof entry, entry === undefined, entry === tally["count"]);
}
// Called in place, an entry sees every argument and a built-in's receiver
// is the record.
for (const name of ["count", "first", "hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf"]) {
  console.log(name, tally[name]!("count", 2, 3), tally[name]!());
}
console.log(tally["hasOwnProperty"]!("first"), tally["hasOwnProperty"]!("toString"), tally["toString"]!());

// An option table: its members are constructors, or lists of one.
type Kind = typeof String | typeof Number | typeof Boolean;
const table: Record<string, Kind | [Kind]> = {
  "--name": String,
  "--count": Number,
  "--force": Boolean,
  "--tag": [String],
};
for (const flag of ["--name", "--count", "--force", "--tag", "--nope", "toString", "hasOwnProperty"]) {
  const kind = table[flag];
  if (kind === undefined) console.log(flag, "no such option");
  else if (Array.isArray(kind)) console.log(flag, "list of", kind[0] === String ? "strings" : "others");
  else console.log(flag, typeof kind, kind === String, kind === Number, kind === Boolean);
}
for (const flag of Object.keys(table)) {
  const kind = table[flag]!;
  const type = Array.isArray(kind) ? kind[0] : kind;
  console.log(flag, type.name, type.length, JSON.stringify(type("12")), JSON.stringify(type()));
}

// A constructor held under a function type with fixed parameters: a call
// that passes its first argument is the constructor's call, whether the
// type's first parameter is required, optional or untyped, and whoever
// calls it (an array method passes more than the type lists).
function through(convert: (value: string) => unknown, raw: string): unknown {
  return convert(raw);
}
function maybe(convert: (value?: string) => unknown, raw: string): unknown {
  return convert(raw);
}
function loose(convert: (value: unknown) => unknown, raw: unknown): unknown {
  return convert(raw);
}
function handle(convert: (value: string, name: string, previous?: unknown) => unknown): unknown {
  return convert("7", "--n");
}
const held = { text: String, amount: Number, flag: Boolean };
console.log(through(held.text, "12"), through(held.amount, "12"), through(held.flag, ""));
console.log(maybe(held.text, "a"), maybe(held.amount, "0x10"), maybe(held.flag, "no"));
console.log(loose(held.text, 12), loose(held.amount, true), loose(held.flag, 0), loose(held.text, null));
console.log(handle(held.text), handle(held.amount), handle(held.flag));
const asNumber: (value: string) => unknown = held.amount;
const asText: (value: unknown) => unknown = held.text;
console.log(["4", "2"].map(asNumber).join(","), [1, null, "x"].map(asText).join(","));
console.log(asNumber === Number, asText === String, asText === asNumber);
// Under a function type with no parameter it is called with none.
function produce(make: () => unknown): unknown {
  return make();
}
const blank: () => unknown = held.text;
console.log(JSON.stringify(blank()), produce(held.amount), produce(held.flag), blank === String);
