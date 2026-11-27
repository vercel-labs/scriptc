// A non-null asserted read of a checked-dynamic dictionary keeps the direct
// value: `!` performs no check, so a present key adds and writes normally.
// A plain (not asserted) read still answers undefined for a missing key.
function bump(target: unknown, key: string, by: number): number {
  const record = target as Record<string, number>;
  return record[key]! + by;
}

function doubled(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}

console.log("present", bump({ hits: 2 }, "hits", 3));
console.log("zero", bump({ hits: 0 }, "hits", 4));

const counter: unknown = { hits: 10 };
doubled(counter, "hits", 5);
console.log("write", (counter as Record<string, number>).hits);

const absent: unknown = {};
console.log("probe", (absent as Record<string, number>).hits === undefined);
