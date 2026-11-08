// reduce and reduceRight on an array held as a checked-dynamic value (an
// unknown[]; an array a Node island hands over is held the same way): the
// method runs on the value's kind, as map and filter do.
interface Detail {
  ttl: string | undefined;
  tokens: number | undefined;
}
function oneHour(details: unknown[] | undefined): number | undefined {
  return details?.reduce<number>((total, detail) => {
    const d = detail as Detail;
    return total + (d.ttl === "1h" ? (d.tokens ?? 0) : 0);
  }, 0);
}
const parsed: unknown[] = JSON.parse(
  '[{"ttl":"1h","tokens":3},{"ttl":"5m","tokens":9},{"ttl":"1h"},{"ttl":"1h","tokens":4}]',
);
console.log(oneHour(undefined), oneHour(parsed), oneHour([]));
console.log(
  parsed.map((d) => (d as Detail).ttl).join(","),
  parsed.filter((d) => (d as Detail).tokens !== undefined).length,
);

const nums: unknown[] = JSON.parse("[1,2,3,4]");
console.log(nums.reduce<number>((a, b) => a + (b as number), 0));
console.log(nums.reduce<string>((a, b, i) => `${a}${i}:${String(b)};`, ""));
console.log(nums.reduceRight<string>((a, b) => a + String(b), ""));

// Without a seed the first element seeds, and an empty array throws.
console.log(String(nums.reduce((a, b) => (a as number) * (b as number))));
const empty: unknown[] = JSON.parse("[]");
try {
  empty.reduce((a, b) => a ?? b);
  console.log("no throw");
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}

// The callback receives the index and the array.
const seen: number[] = [];
nums.reduce<number>((a, _b, i, all) => {
  seen.push(all.length - i);
  return a;
}, 0);
console.log(seen.join(","));

// A callback that throws ends the walk with its error.
try {
  nums.reduce<number>((a, b) => {
    if (b === 3) throw new Error("stop at 3");
    return a + (b as number);
  }, 0);
} catch (e) {
  console.log((e as Error).message);
}
