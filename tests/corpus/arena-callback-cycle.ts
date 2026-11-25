// Family probe: CYCLES. A heap object on a reference cycle that holds a
// reference into a group would be freed by the collector after the group's
// arena was dropped. The cycle is made behind a virtual call, behind a
// callback, and directly (the control), by a holder of a root's value and
// by a call inside a call region.
class Leaf {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
class Ring {
  next: Ring | null = null;
  hold: Leaf[] | null = null;
}
class Maker {
  ring(): Ring {
    const a = new Ring();
    const b = new Ring();
    a.next = b;
    b.next = a;
    return a;
  }
  ringAround(xs: Leaf[]): Ring {
    const a = this.ring();
    a.hold = xs;
    return a;
  }
}
class TightMaker extends Maker {
  override ring(): Ring {
    const a = new Ring();
    a.next = a;
    return a;
  }
  override ringAround(xs: Leaf[]): Ring {
    const a = new Ring();
    a.next = a;
    a.hold = xs;
    return a;
  }
}
function build(n: number): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < n; i++) out.push(new Leaf(i));
  return out;
}
function sum(xs: Leaf[] | null): number {
  let s = 0;
  if (xs !== null) for (const x of xs) s += x.v;
  return s;
}
function tieStore(xs: Leaf[], m: Maker): Ring {
  const r = m.ring();
  r.hold = xs;
  return r;
}
function tieArg(xs: Leaf[], m: Maker): Ring {
  return m.ringAround(xs);
}
function tieCallback(xs: Leaf[], cb: (x: Leaf[]) => Ring): Ring {
  return cb(xs);
}
function tieDirect(xs: Leaf[]): Ring {
  const a = new Ring();
  a.next = a;
  a.hold = xs;
  return a;
}
function holderStore(m: Maker, n: number): number {
  const t = build(n);
  const w = tieStore(t, m);
  return sum(t) + sum(w.hold);
}
function holderArg(m: Maker, n: number): number {
  const t = build(n);
  const w = tieArg(t, m);
  return sum(t) + sum(w.hold);
}
function holderCallback(n: number): number {
  const t = build(n);
  const w = tieCallback(t, (x) => {
    const a = new Ring();
    a.next = a;
    a.hold = x;
    return a;
  });
  return sum(t) + sum(w.hold);
}
function holderDirect(n: number): number {
  const t = build(n);
  const w = tieDirect(t);
  return sum(t) + sum(w.hold);
}
function regionCallback(n: number): number {
  const t = build(n);
  let s = sum(t);
  for (let i = 0; i < 2; i++) {
    s += sum(
      tieCallback(t, (x) => {
        const a = new Ring();
        a.next = a;
        a.hold = x;
        return a;
      }).hold,
    );
  }
  return s;
}
function regionDirect(n: number): number {
  const t = build(n);
  let s = sum(t);
  for (let i = 0; i < 2; i++) s += sum(tieDirect(t).hold);
  return s;
}
const makers: Maker[] = [new Maker(), new TightMaker()];
let total = 0;
for (let r = 0; r < 6000; r++) {
  const m = makers[r % 2]!;
  const n = 30 + (r % 5);
  total += holderStore(m, n);
  total += holderArg(m, n);
  total += holderCallback(n);
  total += holderDirect(n);
  total += regionCallback(n);
  total += regionDirect(n);
}
console.log(total);
