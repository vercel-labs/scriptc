// A record value converted from an untyped value into a narrower record
// type whose fields begin the wider record's storage is the same object:
// a write through either name shows through the other, untyped views of
// the narrower name see every property, and identity holds.
type Wide = { a: number; b: string; c: boolean; d: number };
type Narrow = { a: number; b: string };
type Head = { a: number };
function make(): unknown {
  return { a: 1, b: "x", c: true, d: 4 } satisfies Wide;
}
const src = make();
const w = src as Wide;
const n = src as Narrow;
n.a = 10;
console.log(w.a, (src as Head).a);
w.b = "y";
console.log(n.b);
console.log(JSON.stringify(src), JSON.stringify(n));
const n2 = src as Narrow;
console.log(n2 === n, n2.a);
(src as Record<string, unknown>).a = 30;
console.log(w.a, n.a, (src as Head).a);
console.log(Object.keys(n).join(","), JSON.stringify({ n }), (n as unknown) === src);
console.log(n);

// A native record boxed and narrowed in a function.
function narrow(value: unknown): Narrow {
  return value as Narrow;
}
const wide: Wide = { a: 1, b: "p", c: false, d: 2 };
const seen = narrow(wide);
seen.b = "q";
wide.a = 5;
console.log(wide.b, seen.a, JSON.stringify(seen));

// Narrowing to a leading field of a record whose other fields are scalars.
type Sample = { a: number; b: number; c: boolean };
const items: Sample[] = [
  { a: 1, b: 10, c: true },
  { a: 2, b: 20, c: false },
];
function asHead(value: unknown): Head {
  return value as Head;
}
const heads = items.map((item) => asHead(item));
for (const head of heads) head.a *= 10;
items[0]!.a += 1;
console.log(JSON.stringify(items), JSON.stringify(heads), heads[0]!.a);
const last = items[items.length - 1]!;
const second = asHead(last);
second.a = 7;
console.log(last.a, (second as unknown) === (last as unknown), Object.keys(second).join(","));
