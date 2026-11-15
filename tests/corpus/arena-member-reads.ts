// A reference read out of a value that was just made, and kept after the
// statement that made it: a member, an element, a getter's or a method's
// answer, a destructured name, an optional chain, read off a construction,
// a call's result, a literal or a function that hands its argument back.
// The value's group must not take an arena that the statement drops: every
// reference kept here is read again after the heap has been reused.
interface Crate {
  weight: number;
}
interface Pallet {
  crates: Crate[];
  bay: number;
}
class Shelf {
  crates: Crate[];
  front: Crate;
  constructor(crates: Crate[]) {
    this.crates = crates;
    this.front = crates[0]!;
  }
  get stock(): Crate[] {
    return this.crates;
  }
  all(): Crate[] {
    return this.crates;
  }
  first(): Crate {
    return this.front;
  }
}
class Ledger {
  list: Crate[] = [];
  one: Crate = { weight: -1 };
}
function crates(base: number): Crate[] {
  const made: Crate[] = [];
  for (let i = 0; i < 4; i++) made.push({ weight: base + i });
  return made;
}
function stocked(base: number): Shelf {
  return new Shelf(crates(base));
}
function pallet(base: number): Pallet {
  return { crates: crates(base), bay: base };
}
function sameShelf(shelf: Shelf): Shelf {
  return shelf;
}
function maybeShelf(shelf: Shelf, on: boolean): Shelf | undefined {
  return on ? shelf : undefined;
}
function tally(list: Crate[]): number {
  let total = list.length * 1000;
  for (const crate of list) total += crate.weight;
  return total;
}
// Allocates and frees enough to reuse whatever a dropped group released.
function churn(): number {
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const spare = crates(500 + i);
    const shelf = stocked(700 + i);
    total += spare.length + shelf.crates.length;
  }
  return total;
}

// Module level: each read lands in a module binding.
const byMember = new Shelf(crates(10)).crates;
const byElement = crates(20)[1]!;
const byGetter = stocked(30).stock;
const byMethod = new Shelf(crates(40)).all();
const byMethodRow = stocked(50).first();
const byIdentity = sameShelf(new Shelf(crates(60))).crates;
const byChain = maybeShelf(stocked(70), true)?.crates ?? [];
const byLiteral = { crates: crates(80), bay: 8 }.crates;
const byRecord = pallet(90).crates[2]!;
const { crates: byPattern } = stocked(100);
const [, byArrayPattern] = crates(110);
churn();
console.log(tally(byMember), byElement.weight, tally(byGetter), tally(byMethod), byMethodRow.weight);
console.log(tally(byIdentity), tally(byChain), tally(byLiteral), byRecord.weight);
console.log(tally(byPattern), byArrayPattern!.weight);

// In functions: stored in a field, an element, a Map, by a callee, in a
// closure, or returned.
const ledger = new Ledger();
const lists: Crate[][] = [[]];
const singles: Crate[] = [];
const named = new Map<string, Crate[]>();
let lastKept: Crate[] = [];
let later: () => Crate = () => ({ weight: -1 });
function keep(list: Crate[]): number {
  lastKept = list;
  return list.length;
}
function intoField(): void {
  ledger.list = new Shelf(crates(120)).crates;
  ledger.one = crates(130)[3]!;
}
function intoElements(): void {
  lists[0] = stocked(140).stock;
  singles.push(pallet(150).crates[0]!);
  named.set("a", sameShelf(stocked(160)).all());
}
function intoCallee(): number {
  return keep(new Shelf(crates(170)).crates);
}
function intoClosure(): void {
  const got = stocked(180).first();
  later = () => got;
}
function handedBack(): Crate[] {
  return new Shelf(crates(190)).crates;
}
function handedBackRow(): Crate {
  return crates(200)[2]!;
}
function acrossWork(): number {
  const held = stocked(210).crates;
  const one = crates(220)[1]!;
  churn();
  return tally(held) + one.weight;
}
intoField();
intoElements();
const kept = intoCallee();
intoClosure();
const back = handedBack();
const backRow = handedBackRow();
churn();
console.log(tally(ledger.list), ledger.one.weight, tally(lists[0]!), singles[0]!.weight, tally(named.get("a")!));
console.log(kept, tally(lastKept), later().weight, tally(back), backRow.weight, acrossWork());

// In a loop: every pass reads a new value and keeps a part of it.
const perPass: Crate[][] = [];
const fronts: Crate[] = [];
function passes(count: number): number {
  let seen = 0;
  for (let i = 0; i < count; i++) {
    perPass.push(new Shelf(crates(300 + 10 * i)).crates);
    fronts.push(stocked(400 + 10 * i).first());
    seen += churn();
  }
  return seen;
}
const seen = passes(3);
let loopTotal = 0;
for (const list of perPass) loopTotal += tally(list);
for (const crate of fronts) loopTotal += crate.weight;
console.log(seen, loopTotal);

// Reads that stay in their statement keep working.
function readsOnly(): number {
  return new Shelf(crates(1)).crates.length + crates(2)[3]!.weight + stocked(3).first().weight;
}
console.log(readsOnly());
