// A record of declared fields updated through an untyped helper. The helper
// takes `unknown` and reads and writes with run-time string keys; only keys
// that name a field of the record are written, and absent keys are tested
// first.
type Stats = { hits: number; misses: number; bytes: number; name: string };

function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  if (key in record) record[key] = record[key]! + by;
}

const stats: Stats = { hits: 0, misses: 0, bytes: 0, name: "s" };
const keys = ["hits", "misses", "bytes", "absent"];
for (let i = 0; i < 40; i++) bump(stats, keys[i % keys.length]!, i % 3);
console.log(stats.hits, stats.misses, stats.bytes, stats.name);
console.log("hits" in stats, "absent" in stats, stats.hits);
