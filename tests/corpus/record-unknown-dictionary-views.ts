// Records stored as `unknown` array elements and cast to a dictionary type
// keep their identity: writes through the view reach the record, and reads
// of fields of the dictionary's value type answer the record's values. The
// elements come from map(), an array literal and an array of records.
type Stats = { hits: number; misses: number; name: string };
const stats: Stats[] = [
  { hits: 1, misses: 0, name: "a" },
  { hits: 5, misses: 2, name: "b" },
];

const mapped: unknown[] = stats.map((s) => s as unknown);
const first = mapped[0] as Record<string, number>;
first["hits"] = first["hits"]! + 1;
console.log(stats[0]!.hits, (first as unknown) === stats[0], first["misses"]);

const listed: unknown[] = [stats[1]];
const second = listed[0] as Record<string, number>;
second["misses"] = second["misses"]! * 10;
console.log(stats[1]!.misses, second["hits"]);

const copied: unknown[] = stats;
const again = copied[1] as Record<string, number>;
again["hits"] = 50;
console.log(stats[1]!.hits, again === second);

const returned: unknown[] = stats.map((s) => {
  return s as unknown;
});
const third = returned[0] as Record<string, number>;
third["misses"] = 7;
console.log(stats[0]!.misses, third === first);

function bump(view: Record<string, number>, key: "hits" | "misses"): void {
  view[key] = view[key]! + 100;
}
bump(mapped[1] as Record<string, number>, "hits");
console.log(stats[1]!.hits, JSON.stringify(stats));
