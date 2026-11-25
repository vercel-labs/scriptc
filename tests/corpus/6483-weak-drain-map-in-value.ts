// A WeakMap that only the value of another collection's entry holds.
//
// A long-lived collection files a holder under each book; the holder names
// the book and a desk, and the desk's own WeakMap files a slip under the same
// book. The book is held by its two values and nothing else, so both entries
// are dead as soon as the round ends, but no count says so: the entries go
// when the runtime judges them or when the book's last holder is freed, and
// then one key's end reaches a collection that is alive and one that is
// being freed with its value. Every tenth round forces a collector pass
// while the round's objects are alive, which ages the desks' collections
// but not the desks.
class Mote {
  other: Mote | null = null;
}

// Dead two-object cycles: enough of them make the collector run a pass over
// the young objects while the caller's locals are alive.
function churn(n: number): void {
  for (let i = 0; i < n; i++) {
    const a = new Mote();
    const b = new Mote();
    a.other = b;
    b.other = a;
  }
}

class Book {
  shelf: number;
  pages: Array<number>;
  constructor(shelf: number) {
    this.shelf = shelf;
    this.pages = [shelf, shelf + 1, shelf + 2, shelf + 3];
  }
}

class Slip {
  readonly book: Book;
  due: number;
  constructor(book: Book, due: number) {
    this.book = book;
    this.due = due;
  }
}

class Desk {
  readonly loans: WeakMap<Book, Slip> = new WeakMap();
  partner: Desk | null = null;
}

type Holder = {desk: Desk; book: Book};

const wide: WeakMap<object, unknown> = new WeakMap();
const typed: WeakMap<Book, Holder> = new WeakMap();
let sum = 0;

function round(n: number): void {
  const book = new Book(n);
  const desk = new Desk();
  const other = new Desk();
  desk.partner = other;
  other.partner = desk;
  const holder: Holder = {desk, book};
  if (n % 2 === 0) wide.set(book, holder);
  else typed.set(book, holder);
  desk.loans.set(book, new Slip(book, n));
  other.loans.set(book, new Slip(book, n + 1));
  if (n % 10 === 0) churn(200);
  sum += desk.loans.has(book) ? 1 : 0;
  sum += other.loans.get(book)!.due % 3;
  sum += wide.has(book) || typed.has(book) ? 1 : 0;
}

for (let i = 1; i <= 3000; i++) {
  round(i);
}
console.log('map in value', sum);
