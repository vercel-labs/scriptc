// A constructor that lets `this` escape only does so from a certain
// statement on. Fields it stores before that point are still construction-
// only: no other code could see the object yet, so they keep their value and
// cannot close a cycle. Stores from the escaping statement on are ordinary
// writes: they may close cycles (the sanitized lane's RC audit fails if one
// leaks) and their values may be replaced while other code reads them.

class Item {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

const registry: Node[] = [];

class Node {
  readonly item: Item;
  readonly id: number;
  peer: Node | null;
  late: Item | null;
  constructor(id: number, item: Item) {
    this.id = id;
    this.item = item;
    this.peer = null;
    registry.push(this);
    // After the escape: these stores can see (and close cycles with)
    // objects created after this one.
    this.peer = registry.length > 1 ? registry[registry.length - 2]! : null;
    this.late = new Item(`late${id}`);
  }
}

class Linked extends Node {
  back: Node | null;
  constructor(id: number) {
    super(id, new Item(`linked${id}`));
    // The base constructor already let `this` escape.
    this.back = registry[0] ?? null;
    if (this.back !== null) this.back.peer = this;
  }
}

function useAfter(item: Item, drop: () => void): string {
  drop();
  const noise: Item[] = [];
  for (let i = 0; i < 64; i++) noise.push(new Item(`noise${i}`));
  return `${item.name}/${noise.length}`;
}

let total = 0;
for (let round = 0; round < 200; round++) {
  const a = new Node(round, new Item(`a${round}`));
  const b = new Linked(round + 1);
  // Pre-escape field of a local owner, borrowed while every other
  // reference goes away.
  total += useAfter(a.item, () => {
    registry.length = 0;
  }).length;
  // A post-escape field replaced while it is being read.
  total += useAfter(b.late!, () => {
    b.late = new Item("replaced");
  }).length;
  total += (a.peer === null ? 0 : 1) + (b.back === a ? 1 : 0) + (a.peer === b ? 1 : 0);
}
console.log(total, registry.length);
