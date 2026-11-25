// A value a callee builds out of the members of a list that was just made
// (a filtered or mapped copy, a list of the first few, a record that wraps
// one), kept while the list is alive, in functions whose caller keeps only
// the string they return. The list's objects are one group that is released
// at once; the value built from them holds references into that group and
// has to let go of them before the group is released, wherever its own
// memory comes from.
class Book {
  shelf: number;
  title: string;
  constructor(shelf: number, title: string) {
    this.shelf = shelf;
    this.title = title;
  }
  describe(): string {
    return this.title + "@" + String(this.shelf);
  }
}
interface Loan {
  book: Book;
  days: number;
}
function books(n: number): Book[] {
  const made: Book[] = [];
  for (let i = 0; i < n; i++) made.push(new Book(i, "book" + String(i * 7)));
  return made;
}
function rows(n: number): number[][] {
  const made: number[][] = [];
  for (let i = 0; i < n; i++) made.push([i, i + n, i * n]);
  return made;
}
function pairs(n: number): [number, string][] {
  const made: [number, string][] = [];
  for (let i = 0; i < n; i++) made.push([i, "pair" + String(i * 11)]);
  return made;
}
function loans(n: number): Loan[] {
  const made: Loan[] = [];
  for (let i = 0; i < n; i++) made.push({ book: new Book(i, "lent" + String(i * 5)), days: i + 1 });
  return made;
}
function firstTwo(list: Book[]): Book[] {
  const out: Book[] = [];
  if (list.length > 0) out.push(list[0]!);
  if (list.length > 1) out.push(list[1]!);
  return out;
}
function evenShelves(list: Book[]): Book[] {
  const out: Book[] = [];
  for (const book of list) if (book.shelf % 2 === 0) out.push(book);
  return out;
}
class Desk {
  limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  within(list: Book[]): Book[] {
    const out: Book[] = [];
    for (const book of list) if (book.shelf < this.limit) out.push(book);
    return out;
  }
}

// The copy in a second local.
function secondLocal(n: number): string {
  const all = books(n);
  const head = firstTwo(all);
  return String(head.length) + head[1]!.describe() + String(all.length);
}
// The copy made from a list used in place.
function inPlace(n: number): string {
  const head = firstTwo(books(n));
  return String(head.length) + head[0]!.describe();
}
// One element of a copy, held in a local.
function oneElement(n: number): string {
  const picked = evenShelves(books(n))[1];
  return picked === undefined ? "none" : picked.describe();
}
function throughTwo(n: number): string {
  const picked = firstTwo(evenShelves(books(n)))[1];
  return picked === undefined ? "none" : picked.describe();
}
// Reads off a filtered and a mapped copy.
function filtered(n: number): string {
  const book = books(n).filter((b) => b.shelf > 1)[1];
  const row = rows(n).filter((r) => r[0]! > 0)[1]!;
  const pair = pairs(n).filter((p) => p[0] !== 1).at(1);
  const [, loan] = loans(n).filter((l) => l.days > 1);
  return (
    (book === undefined ? "none" : book.describe()) +
    " " +
    row.join(",") +
    " " +
    (pair === undefined ? "none" : String(pair[0]) + pair[1]) +
    " " +
    (loan === undefined ? "none" : loan.book.describe() + "/" + String(loan.days))
  );
}
function mapped(n: number): string {
  const book = books(n).map((b) => b)[2];
  const row = rows(n).map((r) => r)[2]!;
  const [, pair] = pairs(n).map((p) => p);
  const loan = loans(n).map((l) => l).at(2);
  return (
    (book === undefined ? "none" : book.describe()) +
    " " +
    row.join(",") +
    " " +
    (pair === undefined ? "none" : String(pair[0]) + pair[1]) +
    " " +
    (loan === undefined ? "none" : loan.book.describe() + "/" + String(loan.days))
  );
}
// A callback that wraps each member in a record.
function wrapped(n: number): string {
  const all = books(n);
  const lent = all.map((book) => ({ book, days: book.shelf * 2 }));
  return lent[2]!.book.describe() + "/" + String(lent[2]!.days) + String(all.length);
}
// A method that hands back the members it was given.
function byDesk(n: number): string {
  const desk = new Desk(3);
  const all = books(n);
  const near = desk.within(all);
  return near[2]!.describe() + String(near.length);
}
// Every round makes a list and a copy of its own.
function rounds(n: number): string {
  let out = "";
  for (let k = 2; k < n; k++) {
    const all = books(k + 1);
    const head = firstTwo(all);
    const picked = evenShelves(all)[1];
    out += head[1]!.describe() + (picked === undefined ? "-" : picked.title) + ";";
  }
  return out;
}

console.log("secondLocal " + secondLocal(5));
console.log("inPlace " + inPlace(5));
console.log("oneElement " + oneElement(6));
console.log("throughTwo " + throughTwo(6));
console.log("filtered " + filtered(6));
console.log("mapped " + mapped(6));
console.log("wrapped " + wrapped(6));
console.log("byDesk " + byDesk(6));
console.log("rounds " + rounds(6));
