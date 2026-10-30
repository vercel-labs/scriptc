// Records that leave a typed collection through an `IterableIterator<T>`
// method or a `Generator<T>` keep the order their literals create (title
// before id), including copies that spread a value of their own type. The
// iterators stay live and hand out the stored objects themselves.
interface Book {
  id: string;
  title: string;
  version: number;
}
type BookDraft = Omit<Book, "id" | "version">;
type BookPatch = Partial<BookDraft>;

class Repo<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  put(row: T): void {
    this.rows.set(row.id, row);
  }
  get(id: string): T | undefined {
    return this.rows.get(id);
  }
  all(): IterableIterator<T> {
    return this.rows.values();
  }
  ids(): IterableIterator<string> {
    return this.rows.keys();
  }
}

function* newest(books: readonly Book[]): Generator<Book> {
  for (let i = books.length - 1; i >= 0; i--) yield books[i]!;
}

const books = new Repo<Book>();
let n = 0;
function create(draft: BookDraft): Book {
  const book: Book = { ...draft, id: "b" + ++n, version: 1 };
  books.put(book);
  return book;
}
function update(id: string, patch: BookPatch): Book {
  const current = books.get(id)!;
  const next: Book = { ...current, ...patch, version: current.version + 1 };
  books.put(next);
  return next;
}

create({ title: "Dune" });
const live = books.all();
console.log(JSON.stringify(create({ title: "Emma" })));
console.log(JSON.stringify(update("b1", { title: "Dune II" })));
const listed = [...live];
console.log(JSON.stringify(listed));
console.log(listed.length, listed[0] === books.get("b1"), [...books.ids()].join());
for (const book of books.all()) console.log(Object.keys(book).join());
const ordered = [...newest(listed)];
console.log(JSON.stringify(ordered), ordered[0] === listed[1]);
const step = newest(listed).next();
console.log(step.done, JSON.stringify(step.value));

// Deleting the current entry before leaving a loop over an iterator-typed
// method: the iterator parks after that entry and continues with the next.
class Store {
  readonly rows = new Map<string, number>();
  readonly tags = new Set<string>();
  values(): IterableIterator<number> {
    return this.rows.values();
  }
  keys(): IterableIterator<string> {
    return this.rows.keys();
  }
  tagValues(): IterableIterator<string> {
    return this.tags.values();
  }
  anyPairs(): IterableIterator<any> {
    return this.rows.entries();
  }
  unknownPairs(): IterableIterator<unknown> {
    return this.rows.entries();
  }
  tagAny(): IterableIterator<any> {
    return this.tags.entries();
  }
}
const store = new Store();
for (const [k, v] of [["a", 1], ["b", 2], ["c", 3]] as const) store.rows.set(k, v);
for (const t of ["x", "y", "z"]) store.tags.add(t);
console.log(JSON.stringify([...store.anyPairs()]), JSON.stringify([...store.unknownPairs()]));
console.log(JSON.stringify([...store.tagAny()]));
const values = store.values();
for (const v of values) {
  if (v === 2) {
    store.rows.delete("b");
    break;
  }
}
console.log([...values].join(), [...store.rows.keys()].join());
for (const k of store.keys()) {
  store.rows.delete(k);
  break;
}
console.log([...store.rows.keys()].join());
const tags = store.tagValues();
for (const t of tags) {
  if (t === "y") {
    store.tags.delete("y");
    break;
  }
}
console.log([...tags].join(), [...store.tags].join());
