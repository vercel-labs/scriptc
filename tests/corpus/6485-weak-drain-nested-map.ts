// A WeakMap whose values hold further WeakMaps, whose values hold the outer
// keys.
//
// An archive files a folder under each book; the folder owns a WeakMap of
// its own that files a note under a page, and the note names the book the
// folder is filed under. Freeing the archive gives up the folder, which
// gives up its inner collection, which gives up the note, which frees the
// outer key while the outer collection is still being taken apart. Archives
// are dropped at once, after one round, or after a few hundred, so the
// collections are of every age when the garbage that holds them goes, and
// every eighth round forces a collector pass while the round's archives are
// alive, which ages their collections ahead of the archives themselves.
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
  constructor(shelf: number) {
    this.shelf = shelf;
  }
}

class Page {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

class Note {
  readonly book: Book;
  readonly page: Page;
  constructor(book: Book, page: Page) {
    this.book = book;
    this.page = page;
  }
}

class Folder {
  readonly notes: WeakMap<Page, Note> = new WeakMap();
  first: Page | null = null;
  archive: Archive | null = null;
}

class Archive {
  readonly folders: WeakMap<Book, Folder> = new WeakMap();
  twin: Archive | null = null;
  last: Book | null = null;
}

const kept: Array<Archive> = [];
let sum = 0;

function fill(archive: Archive, n: number): void {
  const book = new Book(n);
  const folder = new Folder();
  const page = new Page(n);
  folder.first = page;
  folder.notes.set(page, new Note(book, page));
  if (n % 2 === 0) folder.archive = archive;
  archive.folders.set(book, folder);
  sum += archive.folders.get(book)!.notes.get(page)!.book.shelf % 3;
  if (n % 5 === 0) archive.last = book;
}

function round(n: number): void {
  const a = new Archive();
  const b = new Archive();
  a.twin = b;
  b.twin = a;
  fill(a, n);
  fill(a, n + 1);
  fill(b, n + 2);
  if (n % 8 === 0) churn(200);
  const slot = n % 250;
  if (kept.length <= slot) kept.push(a);
  else {
    fill(kept[slot], n + 3);
    if (n % 3 === 0) kept[slot] = b;
  }
}

for (let i = 1; i <= 2500; i++) {
  round(i);
}
let last = 0;
for (const archive of kept) last += archive.last === null ? 0 : archive.last.shelf % 11;
console.log('nested map', sum, last);
