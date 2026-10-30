// Typed-array unions chosen through class values, and held in fields,
// parameters, returns and records.

type UintArray = Uint8Array | Uint16Array | Uint32Array;

const pick = (max: number): { new (n: number): UintArray } =>
  max <= 2 ** 8 ? Uint8Array : max <= 2 ** 16 ? Uint16Array : Uint32Array;

class Stack {
  heap: UintArray;
  length = 0;
  constructor(max: number) {
    const Heap = pick(max);
    this.heap = new Heap(max);
  }
  push(n: number): void {
    this.heap[this.length++] = n;
  }
  pop(): number | undefined {
    return this.heap[--this.length];
  }
}

for (const max of [10, 1000, 100000]) {
  const stack = new Stack(max);
  for (let i = 1; i <= 4; i++) stack.push(i * 250);
  console.log(stack.heap.BYTES_PER_ELEMENT, stack.pop(), stack.pop(), stack.length);
}

function grow(xs: UintArray, by: number): UintArray {
  const Next = pick(xs.length * by);
  const out = new Next(xs.length * by);
  out.set(xs);
  return out;
}

const record: { data: UintArray; label: string } = { data: new Uint8Array([1, 2, 3]), label: "r" };
record.data = grow(record.data, 100);
record.data[299] = 65535;
console.log(record.label, record.data.length, record.data[0], record.data[2], record.data[299]);
record.data = grow(record.data, 1000);
console.log(record.data.BYTES_PER_ELEMENT, record.data.length, record.data[1]);
