// A WeakMap on a garbage cycle whose value holds its key.
//
// Two desks hold each other and are dropped every round; one desk's WeakMap
// files a loan slip under a book, and the slip is the only thing that still
// holds the book. A collector pass that runs in the middle of a round finds
// the collection alive (it has been a candidate since it was made) and ages
// it, but not the desks, which nothing has released yet. So the next pass
// over the young objects frees an older collection through the garbage that
// held it: the collection gives up its values one by one, giving up a value
// frees that entry's own key, and the key's end must not take the entry away
// under the walk (a freed entry was read here). Most rounds leave the passes
// where the collector's schedule puts them; every sixteenth forces one in
// the middle.
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
    this.pages = [];
    for (let i = 0; i < 120; i++) {
      this.pages.push(shelf + i);
    }
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

let sum = 0;

function round(n: number): void {
  const book = new Book(n);
  const a = new Desk();
  const b = new Desk();
  a.partner = b;
  b.partner = a;
  a.loans.set(book, new Slip(book, n));
  if (n % 16 === 0) churn(200);
  sum += a.loans.has(book) ? 1 : 0;
}

for (let i = 1; i <= 3000; i++) {
  round(i);
}
console.log('map in cycle', sum);
