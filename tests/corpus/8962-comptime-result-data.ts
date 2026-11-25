// comptime results reach the compiler as data. The evaluator reads a
// result's own enumerable properties once, and nothing the callback hangs
// on the result (replaced array methods, accessors) is ever called by the
// compiler.
const hooked = comptime(() => {
  const values: number[] = [3, 1, 2];
  (values as any).map = () => ["replaced"];
  (values as any).every = () => false;
  return values;
});
console.log(hooked.join(","), hooked.length);

// An accessor on the result is read once, when the result is written out.
const measured = comptime(() => {
  let reads = 0;
  const record = {} as { size: number; label: string };
  Object.defineProperty(record, "size", {
    enumerable: true,
    get: () => {
      reads++;
      return 40 + reads;
    },
  });
  Object.defineProperty(record, "label", { enumerable: true, value: "once" });
  return record;
});
console.log(measured.size, measured.label);

// Missing, undefined and null members, and negative zero, keep their identity.
type Row = { id: number; note: string | null; tag?: string };
const rows = comptime((): Row[] => [
  { id: -0, note: null },
  { id: 2, note: "x", tag: "t" },
  { id: 3, note: "", tag: undefined },
]);
for (const row of rows) console.log(Object.is(row.id, -0), row.note, row.tag);

// Text crosses as UTF-16 code units, lone surrogates and NUL included.
const text = comptime(() => "café 🌍 \u0000 \ud800 end");
const units: number[] = [];
for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
console.log(units.join(" "));

// What the callback does to its own globals stays in the evaluator.
const first = comptime(() => {
  (globalThis as any).counter = ((globalThis as any).counter ?? 0) + 1;
  return (globalThis as any).counter as number;
});
console.log(first);
