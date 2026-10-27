// Record unions with undefined and null arms: NULL and the null sentinel
// encode the unit arms, optional properties keep their absent state, and
// narrowing, nullish operators and equality agree with Node.
type Ok = { ok: true; value: number };
type Err = { ok: false; error: string };
type Res = Ok | Err;

function parse(text: string): Res {
  const n = Number(text);
  return Number.isNaN(n) ? { ok: false, error: `bad ${text}` } : { ok: true, value: n };
}

function lookup(table: Res[], i: number): Res | undefined {
  return i < table.length ? table[i] : undefined;
}

function maybe(i: number): Res | null | undefined {
  if (i % 3 === 0) return null;
  if (i % 3 === 1) return undefined;
  return parse(String(i));
}

const table = ["1", "x", "3"].map(parse);
for (let i = 0; i < 4; i++) {
  const r = lookup(table, i);
  if (r === undefined) console.log(i, "missing");
  else if (r.ok) console.log(i, "value", r.value);
  else console.log(i, "error", r.error);
}

for (let i = 0; i < 6; i++) {
  const m = maybe(i);
  const tag = m === null ? "null" : m === undefined ? "undefined" : m.ok ? "ok" : "err";
  console.log(i, tag, m == null, m ?? "default", typeof m);
}

// Optional properties of a record-union type.
interface Slot {
  name: string;
  result?: Res;
  last?: Res | null;
}
const slots: Slot[] = [
  { name: "a" },
  { name: "b", result: parse("7") },
  { name: "c", result: parse("q"), last: null },
];
for (const s of slots) {
  console.log(s.name, "result" in s, s.result?.ok, s.last === null, s.last === undefined);
}
console.log(JSON.stringify(slots));
slots[0]!.result = table[1];
slots[1]!.result = undefined;
console.log(slots.map((s) => (s.result === undefined ? "-" : s.result.ok ? "ok" : "err")).join(""));

// Equality across arms and unit encodings.
const a: Res | undefined = table[0];
const b: Res | undefined = undefined;
const c: Res | null = null;
console.log(a === table[0], a === b, b === undefined, c === null, (c as Res | null) === table[2]);

// Unions of records reaching unknown and back.
const values: unknown[] = [table[0], table[1], undefined, null];
for (const v of values) {
  if (v === null || v === undefined) console.log("unit", v);
  else console.log("object", JSON.stringify(v));
}
