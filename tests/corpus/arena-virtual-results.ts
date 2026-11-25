// Probe: a fresh object that comes back from a VIRTUAL call (not a `source` in
// region-groups.ts) and is then kept outside the frame: in a module array, in a
// parameter's graph, in a module variable, by a closure. If the calling function
// were taken for one that keeps nothing, its call region's arena would be dropped
// under the kept object. Must print Node's answer, clean under the sanitizers.
class Item {
  label: string;
  next: Item | null = null;
  constructor(label: string) {
    this.label = label;
  }
}
class Maker {
  make(i: number): Item {
    return new Item('a' + i);
  }
  list(n: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < n; i++) out.push(new Item('la' + i));
    return out;
  }
}
class LinkedMaker extends Maker {
  override make(i: number): Item {
    const it = new Item('b' + i);
    it.next = new Item('n' + i);
    return it;
  }
  override list(n: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < n; i++) {
      const it = new Item('lb' + i);
      it.next = new Item('ln' + i);
      out.push(it);
    }
    return out;
  }
}
class Holder {
  items: Item[] = [];
  last: Item | null = null;
}
const saved: Item[] = [];
const holder = new Holder();
let kept: Item | null = null;
const thunks: Array<() => string> = [];

function show(it: Item | null): string {
  return it === null ? '-' : it.label + (it.next === null ? '' : '>' + it.next.label);
}
function viaGlobal(m: Maker, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const it = m.make(i);
    if (i % 7 === 0) saved.push(it);
    s += it.label.length;
  }
  return s;
}
function viaParam(m: Maker, h: Holder, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const it = m.make(i);
    if (i % 9 === 0) h.items.push(it);
    if (i === n - 1) h.last = it;
    s += it.label.length;
  }
  return s;
}
function viaVariable(m: Maker, n: number): number {
  const all = m.list(n);
  kept = all[n >> 1] ?? null;
  return all.length;
}
function viaClosure(m: Maker, n: number): number {
  const all = m.list(n);
  const mid = all[1];
  if (mid !== undefined) thunks.push(() => show(mid));
  return all.length;
}
function viaElement(m: Maker, h: Holder, n: number): number {
  const all = m.list(n);
  for (const it of all) if (it.label.endsWith('3')) h.items.push(it);
  return all.length;
}
function borrowedOnly(m: Maker, n: number): number {
  const all = m.list(n);
  let s = 0;
  for (const it of all) s += it.label.length + (it.next === null ? 0 : 1);
  return s;
}

const makers: Maker[] = [new Maker(), new LinkedMaker()];
let total = 0;
for (let r = 0; r < 8; r++) {
  const m = makers[r % 2]!;
  total += viaGlobal(m, 24);
  total += viaParam(m, holder, 24);
  total += viaVariable(m, 12);
  total += viaClosure(m, 12);
  total += viaElement(m, holder, 14);
  for (let again = 0; again < 3; again++) total += borrowedOnly(m, 40);
}
console.log(total);
console.log(saved.map(show).join(' '));
console.log(holder.items.map(show).join(' '), show(holder.last));
console.log(show(kept), thunks.map((f) => f()).join(' '));
