// The runtime-optional storage section of `scriptc coverage --explain-dynamic`.
// Every slot below is widened to hold undefined because an unchecked read can
// miss; the checker still types each read with the declared type.

const counts: number[] = [1, 2, 3];
const count = counts[0];
if (typeof count === "number") console.log(count + 1);

const labels: Record<string, string> = { a: "x" };
const label = labels["a"];
console.log(label.toUpperCase());

function head(values: number[]): number {
  const [first] = values;
  return first;
}

// A declared optional needs no widening: its absent arm is visible to the
// checker, so it is not part of the report.
function ordinary(value?: number): number {
  return value ?? 0;
}

console.log(head([4, 5]), ordinary());

// A type reference is not a read of the widened storage.
type Count = typeof count;
