// Copies keep the key order of the values they copy: a spread places the
// source's keys at the spread's position in the source's own order, an
// override keeps the position the spread gave it, and new keys follow.
// Rest bindings, width copies, Object.assign and structuredClone keep the
// source order too, including when the source literal was written in
// another order than its type declares.
interface Source {
  a: number;
  b: number;
  c: number;
}
function makeSource(i: number): Source {
  return { c: i, b: i + 1, a: i + 2 };
}

// Spread followed by a new key, and by an override.
interface Extended {
  a: number;
  b: number;
  c: number;
  d: number;
}
const extended: Extended = { ...makeSource(1), d: 4 };
console.log(JSON.stringify(extended), Object.keys(extended).join(","));
const overridden: Source = { ...makeSource(2), b: 0 };
console.log(JSON.stringify(overridden));
interface Led {
  a: number;
  b: number;
  c: number;
  lead: number;
}
const leading: Led = { lead: 0, ...makeSource(3) };
console.log(JSON.stringify(leading));

// A spread whose overrides change field types builds a new shape through
// the field-by-field desugar (scriptc's own frontend-cache writer).
interface Entry {
  ok: true;
  llvm: string;
  ir: string[] | null;
  sidecarJson: string | null;
  features: number;
  sources: [string, string][];
  warnings?: string[];
}
function makeEntry(): Entry {
  return { ok: true, llvm: "L", ir: ["x"], sidecarJson: null, features: 1, sources: [] };
}
const entry = makeEntry();
console.log(JSON.stringify({ schema: "v3", input: { ...entry, llvm: "", ir: null } }));

// Same-shape updates keep every key in place.
interface State {
  name: string;
  count: number;
  last: string | undefined;
}
let state: State = { count: 0, last: undefined, name: "s" };
for (let i = 0; i < 3; i++) state = { ...state, count: state.count + 1, last: "i" + i };
console.log(JSON.stringify(state), Object.keys(state).join(","));
console.log({ ...state, name: "shown" });

// Rest bindings copy the remaining keys in the source's order.
const { b, ...rest } = makeSource(5);
console.log(b, JSON.stringify(rest), Object.keys(rest).join(","));
let picked: number;
let restAgain: { a: number; c: number };
({ b: picked, ...restAgain } = makeSource(6));
console.log(picked, JSON.stringify(restAgain), Object.keys(restAgain).join(","));

// Width copies into an optional-widened type and assignment into a fresh
// target.
interface Wider {
  a: number;
  b: number;
  c: number;
  note?: string;
}
function widen(s: Source): Wider {
  return s;
}
console.log(JSON.stringify(widen(makeSource(7))));
const assigned = Object.assign({ z: 0 }, makeSource(8));
console.log(JSON.stringify(assigned));
console.log(JSON.stringify(structuredClone(makeSource(9))));

// Nested spreads of nested records.
interface Holder {
  inner: Source;
  id: number;
}
const holder: Holder = { id: 1, inner: makeSource(10) };
const copied: Holder = { ...holder, id: 2 };
console.log(JSON.stringify(copied));
console.log(copied);

// Conditional spreads place their key at the spread's position.
interface Options {
  mode: string;
  depth?: number;
  verbose: boolean;
}
function options(deep: boolean): Options {
  return { mode: "m", ...(deep ? { depth: 3 } : {}), verbose: deep };
}
console.log(JSON.stringify(options(true)), JSON.stringify(options(false)));
