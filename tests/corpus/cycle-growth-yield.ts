// Cyclic structures that only grow for a while, then turn over, then grow again.
//
// Shelves form trees with parent back-pointers and a label index. The first
// phase only adds shelves, so the cycle collector's full passes find nothing
// to free; the second retires the oldest shelves as fast as it adds new ones,
// so long-lived cycles become garbage at a steady rate; the third goes back to
// growing. Every retired shelf must be reclaimed (the sanitized lane's RC audit
// checks that nothing is left at exit) and nothing live may be freed (the
// checksums below read every kept shelf after each phase).
class Slot {
  label: string;
  parent: Slot | null = null;
  readonly items: Slot[] = [];
  weight: number;
  constructor(label: string, weight: number) {
    this.label = label;
    this.weight = weight;
  }
}

class Shelf {
  readonly name: string;
  readonly root: Slot;
  readonly byLabel = new Map<string, Slot>();
  constructor(name: string) {
    this.name = name;
    this.root = new Slot(name, 0);
    this.byLabel.set(name, this.root);
  }
}

function stock(name: string, depth: number, fanout: number): Shelf {
  const shelf = new Shelf(name);
  let level: Slot[] = [shelf.root];
  for (let d = 0; d < depth; d++) {
    const next: Slot[] = [];
    for (const parent of level) {
      for (let i = 0; i < fanout; i++) {
        const slot = new Slot(`${parent.label}.${i}`, (d * 7 + i * 3) % 11);
        slot.parent = parent;
        parent.items.push(slot);
        shelf.byLabel.set(slot.label, slot);
        next.push(slot);
      }
    }
    level = next;
  }
  return shelf;
}

function weigh(shelf: Shelf): number {
  let total = 0;
  for (const slot of shelf.byLabel.values()) {
    total += slot.weight;
    if (slot.parent !== null && !slot.parent.items.includes(slot)) total -= 1000000;
  }
  return total;
}

function report(phase: string, shelves: Shelf[]): void {
  let slots = 0;
  let weight = 0;
  for (const shelf of shelves) {
    slots += shelf.byLabel.size;
    weight += weigh(shelf);
  }
  console.log(`${phase}: shelves ${shelves.length} slots ${slots} weight ${weight}`);
}

const shelves: Shelf[] = [];
let opened = 0;

// Growth only.
for (let i = 0; i < 24; i++) shelves.push(stock(`s${opened++}`, 4, 5));
report("grown", shelves);

// Steady turnover of long-lived shelves.
let retired = 0;
for (let i = 0; i < 48; i++) {
  const gone = shelves.shift();
  if (gone !== undefined) retired += gone.byLabel.size;
  shelves.push(stock(`s${opened++}`, 4, 5));
}
report("turned over", shelves);
console.log(`retired slots ${retired}`);

// Growth again.
for (let i = 0; i < 24; i++) shelves.push(stock(`s${opened++}`, 4, 5));
report("regrown", shelves);
const first = shelves[0];
console.log(`first ${first.name} root items ${first.root.items.length}`);
