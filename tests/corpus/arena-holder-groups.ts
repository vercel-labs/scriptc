// Two lists that are each released at once, where the second is built out
// of the first one's members and releases what it holds when it goes (each
// entry also owns a string made for it): the second has to go first, whether
// the two are made in one expression or in two statements. And a list built
// out of another's members among the operands of a call whose own result
// lives longer than the statement.
class Crate {
  slot: number;
  mark: string;
  constructor(slot: number, mark: string) {
    this.slot = slot;
    this.mark = mark;
  }
}
interface Tag {
  crate: Crate;
  text: string;
}
function crates(n: number): Crate[] {
  const made: Crate[] = [];
  for (let i = 0; i < n; i++) made.push(new Crate(i, "crate" + String(i * 3)));
  return made;
}
function tags(list: Crate[]): Tag[] {
  const out: Tag[] = [];
  for (const crate of list) out.push({ crate, text: crate.mark + "!" });
  return out;
}
function doubled(list: Tag[]): Tag[][] {
  const out: Tag[][] = [];
  for (const tag of list) out.push([tag, tag]);
  return out;
}
function firstOf(list: Crate[]): Crate[] {
  const out: Crate[] = [];
  if (list.length > 0) out.push(list[0]!);
  return out;
}
function stock(k: number): Crate[] {
  const made: Crate[] = [];
  for (let i = 0; i < k; i++) made.push(new Crate(i, "stock" + String(i)));
  return made;
}

function inSequence(n: number): string {
  const all = crates(n);
  const marked = tags(all);
  return marked[1]!.crate.mark + marked[1]!.text + String(all.length);
}
function threeInSequence(n: number): string {
  const all = crates(n);
  const marked = tags(all);
  const twice = doubled(marked);
  return twice[2]![1]!.text + String(twice.length) + String(marked.length) + String(all.length);
}
function nested(n: number): string {
  const twice = doubled(tags(crates(n)));
  return twice[2]![0]!.crate.mark + String(twice.length);
}
function secondInPlace(n: number): string {
  const all = crates(n);
  return String(tags(all).length) + all[0]!.mark;
}
function eachRound(n: number): string {
  let out = "";
  for (let k = 1; k < n; k++) {
    const all = crates(k + 1);
    const marked = tags(all);
    out += marked[1]!.text + String(marked.length) + ";";
  }
  return out;
}
// The journal entry stays after the call, so no caller's group surrounds
// this function: the list `firstOf` builds is made while `stock`'s group is
// the one being filled.
const journal: number[][] = [];
function amongOperands(n: number): string {
  journal.push([n]);
  const kept = stock(firstOf(crates(n)).length + 2);
  return kept[1]!.mark + String(journal.length);
}
function amongOperandsInside(n: number): string {
  const kept = stock(firstOf(crates(n)).length + 2);
  return kept[2]!.mark;
}

console.log("inSequence " + inSequence(5));
console.log("threeInSequence " + threeInSequence(5));
console.log("nested " + nested(5));
console.log("secondInPlace " + secondInPlace(5));
console.log("eachRound " + eachRound(5));
console.log("amongOperands " + amongOperands(5));
console.log("amongOperandsInside " + amongOperandsInside(5));
