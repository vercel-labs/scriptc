// Element reads of arrays whose elements are nullable-pointer unions:
// `(Disk | null)[]` reads as `Disk | null | undefined`, mapping the slot's
// NULL (`null`) to the read's `undefined`, and every other pointer in
// place. Holes, present nulls, non-index properties and out-of-range,
// negative, fractional and NaN indices all keep their JavaScript meaning,
// and null stays distinct from undefined.

class Disk {
  size: number;
  constructor(size: number) {
    this.size = size;
  }
}

function describe(value: Disk | null | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return "disk " + value.size;
}

const piles: (Disk | null)[] = [];
piles[0] = new Disk(3);
piles[1] = null;
piles[3] = new Disk(1); // index 2 is a hole

for (const index of [0, 1, 2, 3, 4, -1, 0.5, NaN, -0]) {
  console.log(String(index) + ":", describe(piles[index]));
}

// A present null in a sparse array, through the non-canonical lookup.
const sparse: (Disk | null)[] = [];
sparse[2] = null;
sparse[-1] = null;
sparse[0.5] = new Disk(9);
for (const index of [2, -1, 0.5, 0, 1]) {
  console.log("sparse", String(index) + ":", describe(sparse[index]));
}

// Nullable strings take the same conversion (`null` is the sentinel there,
// not a run-time reference).
const names: (string | null)[] = ["ann", null];
names[3] = "";
for (let i = 0; i < 5; i++) {
  const name = names[i];
  console.log("name", i, name === undefined ? "missing" : name === null ? "null" : `"${name}"`);
}

// Reads narrow back to `Disk | null` after the undefined check.
class Tower {
  piles: (Disk | null)[] = [null, null, null];

  push(pile: number, size: number): void {
    this.piles[pile] = new Disk(size);
  }

  peek(pile: number): Disk | null {
    return this.piles[pile] ?? null;
  }

  pop(pile: number): Disk | null {
    const top = this.piles[pile];
    if (top === undefined) throw new Error("empty pile " + pile);
    this.piles[pile] = null;
    return top;
  }
}

const tower = new Tower();
tower.push(0, 4);
tower.push(0, 2);
tower.push(1, 5);
console.log("peek:", tower.peek(0)?.size, describe(tower.peek(2)));
console.log("pop:", tower.pop(0)?.size, tower.pop(0)?.size, describe(tower.pop(0)));
try {
  tower.pop(2);
} catch (error) {
  console.log("threw:", (error as Error).message);
}

// The non-null assertion keeps the element's own contract.
const first = piles[0];
if (first !== undefined) console.log("asserted:", first!.size);
console.log("hole asserted stays undefined:", piles[2] === undefined);

// A hot loop keeps the read on its inline path and checks that ownership
// survives the array being rewritten between reads.
const counts: (Disk | null)[] = [];
for (let i = 0; i < 8; i++) counts[i] = i % 3 === 0 ? new Disk(i) : null;
let total = 0;
for (let round = 0; round < 200; round++) {
  for (let i = 0; i < 8; i++) {
    const disk = counts[i];
    if (disk === undefined) continue;
    if (disk === null) {
      counts[i] = new Disk(i);
      continue;
    }
    total += disk.size;
  }
}
console.log("total:", total);
