function opaque(value: unknown): unknown { return value; }
const source = new Set<unknown>([1, "one", 0n]);
const record = opaque({ values: source }) as { values: Set<unknown> };
console.log(record.values === source);
record.values.add(2);
const roundTrip = opaque(source) as Set<unknown>;
console.log(roundTrip === source, source.size, source.has(2), source.has(0n));
source.delete(1);
console.log(roundTrip.size, roundTrip.has(1));
console.log(String(opaque(source)), Object.prototype.toString.call(opaque(source)));
console.log("set");

// A typed number-key collection cast back to its checked form keeps its own
// storage; iteration visits its live entries in insertion order.
const numbers = new Set<number>([5, 6, 7.5, 8]);
numbers.delete(6);
const numberView = opaque(numbers) as Set<unknown>;
const seen: unknown[] = [];
for (const value of numberView) seen.push(value);
numberView.forEach((value) => seen.push(value));
console.log(numberView.size, seen.join(","), [...numberView].join(","));
const byId = new Map<number, string>();
for (let i = 0; i < 40; i++) byId.set(i * 1000 + 0.5, `v${i}`);
byId.delete(1000.5);
byId.delete(39000.5);
const mapView = opaque(byId) as Map<unknown, unknown>;
let keys = 0;
let last = "";
for (const [key, value] of mapView) {
  keys += key as number;
  last = value as string;
}
console.log(mapView.size, keys, last, [...mapView.keys()].length, [...mapView.values()][0]);
