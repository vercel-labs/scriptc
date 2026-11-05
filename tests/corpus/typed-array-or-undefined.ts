// Typed arrays in `T | undefined` slots: paged bit sets, optional fields,
// map values, comparisons, printing and JSON.
class PagedBits {
  readonly pages: (Int32Array | undefined)[] = [];
  has(id: number): boolean {
    const page = this.pages[id >> 8];
    return page !== undefined && (page[(id >> 5) & 7]! & (1 << (id & 31))) !== 0;
  }
  add(id: number): void {
    const index = id >> 8;
    let page = this.pages[index];
    if (page === undefined) {
      page = new Int32Array(8);
      while (this.pages.length <= index) this.pages.push(undefined);
      this.pages[index] = page;
    }
    page[(id >> 5) & 7]! |= 1 << (id & 31);
  }
  clearPage(index: number): void {
    this.pages[index] = undefined;
  }
}

const bits = new PagedBits();
for (let i = 0; i < 4000; i += 13) bits.add(i);
for (let i = 2000; i < 2600; i += 7) bits.add(i);
let count = 0;
for (let i = 0; i < 5000; i++) if (bits.has(i)) count++;
console.log("count", count, "pages", bits.pages.length);
console.log(
  "present",
  bits.pages.map((p) => (p === undefined ? "-" : p.length)).join(","),
);
bits.clearPage(3);
let after = 0;
for (let i = 0; i < 5000; i++) if (bits.has(i)) after++;
console.log("after clear", after, bits.pages[3] === undefined, bits.pages[99]);

// A page read past the end and from a hole.
const sparse: (Uint8Array | undefined)[] = [];
sparse[4] = Uint8Array.of(1, 2, 3);
console.log(sparse.length, sparse[0], sparse[4], sparse[9]);
console.log(sparse.findIndex((p) => p !== undefined), sparse.includes(undefined));

// Optional fields and parameters.
class Buffered {
  data: Float64Array | undefined;
  constructor(n: number) {
    this.data = n > 0 ? new Float64Array(n).fill(0.5) : undefined;
  }
  total(): number {
    const d = this.data;
    if (!d) return -1;
    let s = 0;
    for (const x of d) s += x;
    return s;
  }
}
const buffers = [new Buffered(4), new Buffered(0), new Buffered(2)];
console.log(buffers.map((b) => b.total()));
console.log(buffers.map((b) => b.data?.length ?? "none"));
buffers[1]!.data = buffers[0]!.data;
console.log(buffers[1]!.data === buffers[0]!.data, buffers[2]!.data === buffers[0]!.data);
buffers[0]!.data![0] = 9;
console.log(buffers[1]!.total(), typeof buffers[1]!.data, typeof buffers[2]!.data?.[5]);

function pick(a: Int16Array | undefined, b: Int16Array | undefined): Int16Array | undefined {
  return a ?? b;
}
const one = Int16Array.of(-1, 2);
console.log(pick(undefined, one), pick(one, undefined) === one, pick(undefined, undefined));

// Map values and printing.
const byName = new Map<string, Uint32Array | undefined>();
byName.set("a", Uint32Array.of(7, 8));
byName.set("b", undefined);
for (const [k, v] of byName) console.log(k, v, v ? v[1] : "absent");
console.log(byName.get("c"), byName.has("b"));
const row: (Int32Array | undefined)[] = [Int32Array.of(5), undefined];
console.log(row, JSON.stringify(row));
const copy = [...row, Int32Array.of(6)];
console.log(copy.filter((p) => p !== undefined).length, copy.indexOf(row[0]));
