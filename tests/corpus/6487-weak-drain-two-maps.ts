// Two WeakMaps on one garbage cycle, each value holding the other's key.
//
// Two counters trade parcels: each files a receipt under its own parcel, and
// the receipt names the other counter's parcel. The counters hold each other
// and are dropped together, so freeing either collection frees a key of the
// other while that one may be half taken apart, and a key filed at both
// counters ends two entries at once. Every sixth round forces a collector
// pass while the round's counters are alive, which ages their collections
// ahead of the counters.
class Mote {
  other: Mote | null = null;
}

// Dead two-object cycles: enough of them make the collector run a pass over
// the young objects while the caller's locals are alive.
function churn(n: number): void {
  for (let i = 0; i < n; i++) {
    const a = new Mote();
    const b = new Mote();
    a.other = b;
    b.other = a;
  }
}

class Parcel {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class Receipt {
  readonly other: Parcel;
  readonly stamp: number;
  constructor(other: Parcel, stamp: number) {
    this.other = other;
    this.stamp = stamp;
  }
}

class Counter {
  readonly receipts: WeakMap<Parcel, Receipt> = new WeakMap();
  across: Counter | null = null;
  held: Parcel | null = null;
}

const open: Array<Counter> = [];
let sum = 0;

function trade(left: Counter, right: Counter, n: number): void {
  const mine = new Parcel(n);
  const yours = new Parcel(-n);
  left.receipts.set(mine, new Receipt(yours, n));
  right.receipts.set(yours, new Receipt(mine, n + 1));
  if (n % 3 === 0) {
    // One parcel filed at both counters.
    left.receipts.set(yours, new Receipt(mine, n + 2));
  }
  if (n % 11 === 0) left.held = mine;
  sum += left.receipts.get(mine)!.other.id === -n ? 1 : 0;
  sum += right.receipts.get(yours)!.stamp % 4;
}

function round(n: number): void {
  const left = new Counter();
  const right = new Counter();
  left.across = right;
  right.across = left;
  trade(left, right, n);
  trade(right, left, n + 1);
  if (n % 6 === 0) churn(200);
  const slot = n % 200;
  if (open.length <= slot) open.push(left);
  else {
    const old = open[slot];
    trade(old, old.across!, n + 2);
    if (n % 2 === 0) open[slot] = right;
  }
}

for (let i = 1; i <= 2500; i++) {
  round(i);
}
let held = 0;
for (const counter of open) held += counter.held === null ? 0 : 1;
console.log('two maps', sum, held);
