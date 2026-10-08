// Long-lived cyclic structures next to garbage of every age.
//
// Warehouses keep bins with parent back-pointers and a name index for the
// whole run. Each restock builds scratch pick lists (doubly linked, pointing
// into the bins) that live through many collector passes before they are
// dropped, and every few rounds a whole warehouse is retired after it has
// been live for a long time. Every dead structure must be reclaimed without
// touching the live ones: the sanitized lane's RC audit checks that nothing
// is left over at exit, and the checksums check that nothing live was freed.
class Bin {
  label: string;
  parent: Bin | null = null;
  children: Bin[] = [];
  stock: number;
  constructor(label: string, stock: number) {
    this.label = label;
    this.stock = stock;
  }
}

class Warehouse {
  name: string;
  root: Bin;
  index: Map<string, Bin> = new Map();
  constructor(name: string) {
    this.name = name;
    this.root = new Bin(`${name}/root`, 0);
    this.index.set(this.root.label, this.root);
  }
  add(parent: Bin, label: string, stock: number): Bin {
    const bin = new Bin(`${this.name}/${label}`, stock);
    bin.parent = parent;
    parent.children.push(bin);
    this.index.set(bin.label, bin);
    return bin;
  }
}

class Pick {
  bin: Bin;
  qty: number;
  prev: Pick | null = null;
  next: Pick | null = null;
  constructor(bin: Bin, qty: number) {
    this.bin = bin;
    this.qty = qty;
  }
}

function stockWarehouse(name: string, bins: number): Warehouse {
  const w = new Warehouse(name);
  const all: Bin[] = [w.root];
  for (let i = 1; i < bins; i++) all.push(w.add(all[(i - 1) >> 2], `b${i}`, (i * 7) % 13));
  return w;
}

function pickList(w: Warehouse, round: number, length: number): Pick | null {
  let head: Pick | null = null;
  let tail: Pick | null = null;
  for (let i = 0; i < length; i++) {
    const bin = w.index.get(`${w.name}/b${1 + ((i * 31 + round) % (w.index.size - 1))}`);
    if (bin === undefined) continue;
    const p = new Pick(bin, 1 + (i % 3));
    if (tail === null) head = p;
    else {
      tail.next = p;
      p.prev = tail;
    }
    tail = p;
  }
  return head;
}

function depth(bin: Bin): number {
  let d = 0;
  for (let b: Bin | null = bin.parent; b !== null; b = b.parent) d++;
  return d;
}

const warehouses: Warehouse[] = [];
for (let i = 0; i < 4; i++) warehouses.push(stockWarehouse(`w${i}`, 1500));

let pending: (Pick | null)[] = [];
let picked = 0;
let retired = 0;
for (let round = 0; round < 24; round++) {
  const w = warehouses[round % warehouses.length];
  pending.push(pickList(w, round, 400));
  // Lists wait a few rounds before they are fulfilled and dropped.
  if (pending.length > 3) {
    for (const head of pending) {
      for (let p = head; p !== null; p = p.next) picked += p.qty * (1 + depth(p.bin));
    }
    pending = [];
  }
  // Retire the oldest warehouse every eight rounds and open a fresh one.
  if (round % 8 === 7) {
    const gone = warehouses.shift();
    if (gone !== undefined) retired += gone.index.size;
    warehouses.push(stockWarehouse(`w${4 + round}`, 1500));
  }
}

let bins = 0;
let stock = 0;
for (const w of warehouses) {
  bins += w.index.size;
  for (const bin of w.index.values()) {
    stock += bin.stock;
    if (bin.parent !== null && !bin.parent.children.includes(bin)) console.log("broken link", bin.label);
  }
}
console.log(`warehouses ${warehouses.map((w) => w.name).join(",")}`);
console.log(`bins ${bins} stock ${stock} retired ${retired}`);
console.log(`picked ${picked} pending ${pending.length}`);
