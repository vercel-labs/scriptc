// A dead NURSERY cycle holding a traced edge into a MATURE object.
//
// A restricted pass does not trial-delete edges into generations it refuses
// to walk, and a teardown releases only UNTRACED children — so that one edge
// is accounted by neither unless the collector pays it off explicitly. Left
// unaccounted it is a phantom reference: the target reads as externally
// referenced to every later pass, full ones included, and neither it nor
// anything it links to is ever reclaimable. The sanitized lane's RC audit is
// what catches that, so this program's value is in the shape it builds, not
// in what it prints.
//
// Mutating a live linked structure is what produces mature objects here:
// each moveToFront releases the neighbours it unlinks, buffering them as
// cycle-root candidates, and surviving a pass promotes them out of the
// nursery. The dead cycles below then point straight into that older
// generation.
class Item {
  prev: Item | null = null;
  next: Item | null = null;
  extra: Item | null = null;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

class List {
  head: Item | null = null;

  push(label: string): Item {
    const it = new Item(label);
    it.next = this.head;
    if (this.head !== null) this.head.prev = it;
    this.head = it;
    return it;
  }

  moveToFront(it: Item): void {
    if (it === this.head) return;
    const p = it.prev;
    const n = it.next;
    if (p !== null) p.next = n;
    if (n !== null) n.prev = p;
    it.prev = null;
    it.next = this.head;
    if (this.head !== null) this.head.prev = it;
    this.head = it;
  }

  length(): number {
    let n = 0;
    for (let w = this.head; w !== null; w = w.next) n = n + 1;
    return n;
  }
}

// Dead rings, to drive collector passes.
function churn(n: number): void {
  for (let i = 0; i < n; i = i + 1) {
    const x = new Item("x");
    const y = new Item("y");
    x.next = y;
    y.next = x;
  }
}

// Built inside a function so the `items` handles are gone on return and the
// list is held by exactly one reference afterwards.
function build(): List {
  const list = new List();
  const items: Item[] = [];
  for (let i = 0; i < 60; i = i + 1) items.push(list.push(`n${i}`));

  // Churn the live list so its nodes are walked, survive, and get promoted.
  for (let r = 0; r < 30; r = r + 1) {
    for (let i = 0; i < items.length; i = i + 1) list.moveToFront(items[i]);
    churn(200);
  }

  // Dead nursery cycles, each holding a traced edge into the mature list.
  for (let i = 0; i < 40; i = i + 1) {
    const x = new Item("dead-a");
    const y = new Item("dead-b");
    x.next = y;
    y.next = x;
    x.extra = items[i % items.length];
  }
  churn(400);
  return list;
}

let list: List | null = build();

// The list is still whole: nothing above may have collected a live node.
console.log(`length ${list.length()}`);
console.log(`head ${list.head === null ? "none" : list.head.label}`);

// Drop it. Every node must now be reclaimable — under an unpaid cross-
// generation edge, the pointed-at nodes keep phantom counts and the whole
// list survives to the exit audit.
list = null;
churn(400);
console.log("done");
