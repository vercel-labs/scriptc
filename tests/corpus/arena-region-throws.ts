// Exceptions inside call regions: the region's arena is dropped as the
// exception leaves the call, and the caller's own objects are untouched.
interface Entry {
  key: string;
  value: number;
  next: Entry | null;
}

function tally(keys: string[], limit: number): number {
  const entries: Entry[] = [];
  for (const k of keys) {
    entries.push({ key: k, value: k.length, next: entries.length > 0 ? entries[entries.length - 1]! : null });
    if (entries.length > limit) throw new RangeError(`too many entries: ${entries.length}`);
  }
  let sum = 0;
  for (const e of entries) sum += e.value + (e.next === null ? 0 : e.next.value);
  return sum;
}

const kept: Entry[] = [{ key: "outside", value: 1, next: null }];
const keys = "alpha beta gamma delta epsilon zeta eta theta iota kappa".split(" ");
let total = 0;
let errors = 0;
for (let round = 0; round < 40; round++) {
  try {
    total += tally(keys, 3 + (round % 10));
  } catch (e) {
    errors++;
    if (round < 6) console.log((e as Error).name, (e as Error).message);
  }
  kept.push({ key: `k${round}`, value: round, next: kept[kept.length - 1]! });
}
console.log("total", total, "errors", errors, "kept", kept.length, kept[kept.length - 1]!.next!.key);
