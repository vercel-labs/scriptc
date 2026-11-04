// A record handed to an untyped helper that keeps the reference and reads a
// declared field with a constant key. The stored copy and the original are the
// same object, so a typed write afterwards is visible through both.
type Stats = { hits: number; misses: number };

const kept: unknown[] = [];
function remember(target: unknown): number {
  kept.push(target);
  const record = target as Record<string, number>;
  return record.hits!;
}

const stats: Stats = { hits: 10, misses: 3 };
const seen = remember(stats);
stats.hits = seen + 5;
const same = kept[0] as Stats;
console.log(seen, stats.hits, same.hits, same.misses, kept.length);
