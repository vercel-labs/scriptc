// Probe: a fresh list that comes back from a GETTER overridden in a subclass (a
// virtual call), with an element then kept in a parameter's list, and a SETTER,
// overridden too, that stores what it is handed. If the calling function were
// taken for one that keeps nothing, its call region's arena would be dropped
// under the kept object. Must print Node's answer, clean under the sanitizers.
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
function makeList(tag: string, n: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const it = new Item(tag + i);
    it.next = new Item(tag + 'n' + i);
    out.push(it);
  }
  return out;
}
class Shelf {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  get fresh(): Item[] {
    return makeList('g', this.n);
  }
}
class DeepShelf extends Shelf {
  override get fresh(): Item[] {
    return makeList('dg', this.n + 1);
  }
}
class Sink {
  kept: Item[] = [];
  set value(v: Item) {
    this.kept.push(v);
  }
}
class LoudSink extends Sink {
  count = 0;
  override set value(v: Item) {
    this.count++;
    this.kept.push(v);
  }
}
function viaGetter(s: Shelf, h: Holder): number {
  const all = s.fresh;
  for (const it of all) if (it.label.endsWith('3')) h.items.push(it);
  return all.length;
}
function viaSetter(sink: Sink, n: number): number {
  const all = makeList('st', n);
  sink.value = all[3]!;
  return all.length;
}
const holder = new Holder();
const shelves: Shelf[] = [new Shelf(14), new DeepShelf(14)];
const sinks: Sink[] = [new Sink(), new LoudSink()];
let total = 0;
for (let r = 0; r < 40; r++) {
  total += viaGetter(shelves[r % 2]!, holder);
  total += viaSetter(sinks[r % 2]!, 14 + (r % 3));
}
console.log(total, holder.items.length);
console.log(holder.items.map(show).join(' '));
console.log(sinks.map((s) => s.kept.map(show).join(' ')).join(' | '));
