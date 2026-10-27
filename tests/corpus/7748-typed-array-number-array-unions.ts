// Unions of typed arrays and number arrays, as a cache picks its index
// arrays by capacity: a linked list over next/prev index arrays.

type NumberArray = Uint8Array | Uint16Array | Uint32Array | number[];

function indexArray(max: number): NumberArray {
  if (max <= 2 ** 8) return new Uint8Array(max);
  if (max <= 2 ** 16) return new Uint16Array(max);
  if (max <= 2 ** 32) return new Uint32Array(max);
  return new Array<number>(4).fill(0);
}

class Order {
  next: NumberArray;
  prev: NumberArray;
  head = 0;
  tail = 0;
  size = 0;

  constructor(max: number, force = false) {
    this.next = force ? new Array<number>(max).fill(0) : indexArray(max);
    this.prev = force ? new Array<number>(max).fill(0) : indexArray(max);
  }

  push(index: number): void {
    if (this.size === 0) {
      this.head = this.tail = index;
    } else {
      this.next[this.tail] = index;
      this.prev[index] = this.tail;
      this.tail = index;
    }
    this.size++;
  }

  moveToTail(index: number): void {
    if (index === this.tail) return;
    if (index === this.head) this.head = this.next[index]!;
    else this.next[this.prev[index]!] = this.next[index]!;
    this.prev[this.next[index]!] = this.prev[index]!;
    this.next[this.tail] = index;
    this.prev[index] = this.tail;
    this.tail = index;
  }

  walk(): number[] {
    const out: number[] = [];
    for (let i = this.head, n = 0; n < this.size; n++, i = this.next[i]!) out.push(i);
    return out;
  }
}

for (const [max, force] of [
  [8, false],
  [300, false],
  [70000, false],
  [8, true],
] as const) {
  const order = new Order(max, force);
  for (let i = 0; i < 6; i++) order.push(i);
  order.moveToTail(0);
  order.moveToTail(3);
  order.moveToTail(5);
  console.log(max, force, order.walk().join(","), order.next.length, order.prev[3]);
}

// The number-array arm reads holes and missing indexes as undefined,
// and writes past its length grow it.
const arms: NumberArray[] = [new Uint8Array(3), [1, 2, 3]];
for (const a of arms) {
  a[1] = 300;
  a[2] += 0.5;
  a[5] = 8;
  console.log(a.length, a[1], a[2], a[4], a[5]);
  let total = 0;
  for (const v of a) total += v ?? -1;
  console.log(total, [...a].length, Array.from(a).length);
}
