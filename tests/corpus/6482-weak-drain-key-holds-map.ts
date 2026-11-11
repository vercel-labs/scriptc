// A WeakMap, its key and its value on one garbage cycle.
//
// The book (the key) names the desk it is lent at, the desk owns the WeakMap,
// and the slip filed under the book names the book again. Nothing outside
// the cycle holds any of them once the round ends, so a collector pass frees
// the collection, the key and the value together, in whatever order it takes
// them, and the entry must end exactly once. Every third round the book is
// also filed at a second desk that goes first, so one key ends entries in a
// collection that is still alive and in one that is being freed. Every
// twelfth round forces a collector pass while the round's objects are alive,
// which ages the collections but not the desks that hold them.
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

class Desk {
  readonly loans: WeakMap<Book, Slip> = new WeakMap();
  readonly seen: WeakSet<Book> = new WeakSet();
  count: number = 0;
}

class Book {
  shelf: number;
  desk: Desk | null = null;
  constructor(shelf: number) {
    this.shelf = shelf;
  }
}

class Slip {
  readonly book: Book;
  readonly desk: Desk;
  constructor(book: Book, desk: Desk) {
    this.book = book;
    this.desk = desk;
  }
}

let sum = 0;
let spare: Desk = new Desk();

function round(n: number): void {
  const desk = new Desk();
  const book = new Book(n);
  book.desk = desk;
  desk.loans.set(book, new Slip(book, desk));
  desk.seen.add(book);
  desk.count++;
  if (n % 3 === 0) {
    spare.loans.set(book, new Slip(book, spare));
    spare.count++;
  }
  if (n % 12 === 0) churn(200);
  if (n % 50 === 0) {
    sum += spare.count;
    spare = new Desk();
  }
  sum += desk.loans.get(book)!.book.shelf % 5;
  sum += desk.seen.has(book) ? 1 : 0;
}

for (let i = 1; i <= 3000; i++) {
  round(i);
}
console.log('key holds map', sum, spare.count);
