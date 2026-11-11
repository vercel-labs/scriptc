// A tsconfig's `types` entry resolves under a `typeRoots` directory as a
// file or as a directory, as a module does: `measures` is the declaration
// file typings/measures.d.ts, `packed` the directory typings/packed with
// its index.d.ts. Both declare global types of the project, and tsc loads
// both.
function total(measures: Measure[], unit: Unit): number {
  let sum = 0;
  for (const measure of measures) if (measure.unit === unit) sum += measure.amount;
  return sum;
}

const measures: Measure[] = [
  { unit: "m", amount: 3 },
  { unit: "s", amount: 4 },
  { unit: "m", amount: 5 },
];
const packed: Packed = { label: "run", measures };
const unit: Unit = "m";
console.log(total(packed.measures, unit), total(measures, "s"), packed.label, packed.measures.length);
