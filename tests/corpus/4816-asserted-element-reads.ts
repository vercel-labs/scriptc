// Non-null assertions on array and typed-array element reads have no
// runtime effect: a missing element is undefined wherever it goes, and
// reading a property of it throws Node's TypeError.
const bytes = new Uint8Array([7, 8, 9]);
const nums: number[] = [1, 2, 3];
const words: string[] = ["a", "bb", "ccc"];
const grid: number[][] = [
  [1, 2],
  [3, 4],
];
const far = process.argv.length + 9;

function at(xs: number[], i: number): number {
  return xs[i]!;
}

function byte(i: number): number {
  return bytes[i]!;
}

function describe(value: number): string {
  return `${typeof value}:${String(value)}`;
}

console.log(bytes[far]!, nums[far]!, words[far]!, at(nums, far), byte(far), byte(1));
console.log(String(bytes[far]!), typeof nums[far]!, bytes[far]! === undefined, nums[far]! === undefined);
console.log(JSON.stringify({ b: bytes[far]!, n: nums[far]!, w: words[far]! }), [bytes[far]!, nums[far]!]);
console.log(describe(bytes[far]!), describe(nums[far]!), describe(nums[1]!), `${words[far]!}|${words[2]!}`);
console.log(bytes[far]! + 1, nums[far]! * 2, bytes[far]! > 0, nums[far]! < 0, bytes[far]! | 0);

const kept: number[] = [];
kept.push(nums[far]!, bytes[far]!, nums[0]!);
console.log(kept.length, kept, kept.includes(undefined as unknown as number));

const v = nums[far]!;
const w = bytes[far]!;
let total = 0;
for (let i = 0; i < nums.length + 2; i++) total += nums[i]!;
console.log(v, w, total, Number.isNaN(v), Number.isNaN(w));

try {
  console.log(words[far]!.length);
} catch (e) {
  console.log("caught", (e as Error).message);
}
try {
  console.log(words[far]!.toUpperCase());
} catch (e) {
  console.log("caught", (e as Error).message);
}
try {
  console.log(grid[far]![0]!);
} catch (e) {
  console.log("caught", e instanceof TypeError);
}
console.log(grid[1]![far]!, grid[0]![1]!);

// Writes through an asserted target and an out-of-range swap: the array
// grows holes as in Node.
const swapped = [5, 6, 7];
const a = 1;
const b = swapped.length + 1;
const t = swapped[a]!;
swapped[a] = swapped[b]!;
swapped[b] = t;
console.log(swapped.length, swapped, 2 in swapped, 3 in swapped);
bytes[1]! = 42;
bytes[far]! = 5;
console.log(bytes.join(","), bytes.length);

class Cache {
  private readonly slots: string[];
  constructor(size: number) {
    this.slots = new Array<string>(size);
  }
  get(index: number): string {
    if (Object.hasOwn(this.slots, index)) return this.slots[index]!;
    const item = `item${index}`;
    this.slots[index] = item;
    return item;
  }
}
const cache = new Cache(3);
console.log(cache.get(1), cache.get(1), cache.get(2).length);
