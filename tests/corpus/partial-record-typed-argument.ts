// A record literal asserted to a wider record type stays the object it is: a
// helper that takes it untyped reads a field the literal lacks as undefined
// and adds one it does not have, so calls keep the dynamic lowering.
type Stats = { hits: number; misses: number };

function peekField(target: unknown, key: string): any {
  const record = target as Record<string, unknown>;
  return record[key];
}

function addField(target: unknown, key: string, value: number): void {
  const record = target as Record<string, number>;
  record[key] = value;
}

const partial = { hits: 1 } as Stats;
const full: Stats = { hits: 2, misses: 3 };

console.log("peek", peekField(partial, "misses"));
console.log("full peek", peekField(full, "misses"));
addField(partial, "misses", 5);
console.log("after", JSON.stringify(partial));
addField(full, "hits", 7);
console.log("full after", JSON.stringify(full));
