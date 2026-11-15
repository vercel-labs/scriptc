// Family probe: a GENERATOR handed in as a parameter runs its body while the
// draining function's arena is open (for-of, next(), spread); what the body
// allocates is then kept in a parameter's graph or in a module array.
class Item {
  label: string;
  next: Item | null = null;
  constructor(label: string) {
    this.label = label;
  }
}
class Holder {
  items: Item[] = [];
  last: Item | null = null;
}
function show(it: Item | null): string {
  return it === null ? '-' : it.label + (it.next === null ? '' : '>' + it.next.label);
}
function make(tag: string, i: number): Item {
  const it = new Item(tag + i);
  it.next = new Item(tag + 'n' + i);
  return it;
}
const saved: Item[] = [];
function* produce(tag: string, n: number): Generator<Item, void, undefined> {
  for (let i = 0; i < n; i++) {
    const it = make(tag, i);
    if (i % 10 === 7) saved.push(it);
    yield it;
  }
}
function own(n: number): Item[] {
  const mine: Item[] = [];
  for (let i = 0; i < n; i++) mine.push(make('own', i));
  return mine;
}
function viaForOf(g: Generator<Item, void, undefined>, h: Holder, n: number): number {
  const mine = own(n);
  let c = 0;
  for (const it of g) {
    if (it.label.endsWith('3')) h.items.push(it);
    c += it.label.length;
  }
  return c + mine.length;
}
function viaNext(g: Generator<Item, void, undefined>, h: Holder, n: number): number {
  const mine = own(n);
  let c = 0;
  for (let r = g.next(); r.done !== true; r = g.next()) {
    const it = r.value;
    if (it.label.endsWith('3')) h.items.push(it);
    c += it.label.length;
  }
  return c + mine.length;
}
function viaSpread(g: Generator<Item, void, undefined>, h: Holder, n: number): number {
  const mine = own(n);
  const all = [...g];
  h.last = all[2] ?? null;
  return all.length + mine.length;
}
function viaCreate(h: Holder, n: number): number {
  const mine = own(n);
  let c = 0;
  for (const it of produce('c', n)) {
    if (it.label.endsWith('3')) h.items.push(it);
    c += it.label.length;
  }
  return c + mine.length;
}
const holder = new Holder();
let total = 0;
for (let r = 0; r < 40; r++) {
  const n = 14 + (r % 3);
  // Each generator is made in a statement of its own: as an operand, the
  // call that makes it would keep the draining call from being a region.
  const g1 = produce('fo', n);
  total += viaForOf(g1, holder, n);
  const g2 = produce('nx', n);
  total += viaNext(g2, holder, n);
  const g3 = produce('sp', n);
  total += viaSpread(g3, holder, n);
  total += viaCreate(holder, n);
}
console.log(total, holder.items.length, saved.length);
console.log(holder.items.slice(0, 40).map(show).join(' '), show(holder.last));
console.log(saved.slice(0, 40).map(show).join(' '));
