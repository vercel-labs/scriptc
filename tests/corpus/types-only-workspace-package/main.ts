// A workspace package that ships only declarations (its `main` and `types`
// are the same `.d.ts`), linked into node_modules the way pnpm, npm, yarn and
// bun link workspace members: the declarations resolve to a path outside
// node_modules. Every import of it is a type import, so nothing of the package
// runs and no implementation is needed: its interfaces type records the
// program builds, exactly as the same interfaces declared in a `.ts` file do.
import type {
  Batch,
  Book,
  Condition,
  Counter,
  Loan,
  Member,
  Notices,
  Shelf,
} from "lending-types";

// A return type, a parameter, a field of a class.
function bind(isbn: string, title: string): Book {
  return { isbn, title };
}
function callNumber(member: Member, ...parts: string[]): string {
  return [member.branch, member.card, ...parts].join("-");
}
class Desk {
  reading: Book | undefined;
  queue: Member[] = [];
  status(): string {
    return this.reading?.title ?? "idle";
  }
}
const desk = new Desk();
console.log(desk.status());
desk.reading = bind("0-1", "Tides");
const ada: Member = { card: "c7", name: "Ada", branch: "east" };
desk.queue.push(ada, { card: "c8", name: "Bo", branch: "east", joined: 2004 });
console.log(desk.status(), desk.queue.length);
console.log(callNumber(ada, "hold"), ada.joined ?? "unknown", desk.queue[1]!.joined);

// An array element, a Map value, a generic argument.
function last<T>(items: T[]): T {
  return items[items.length - 1]!;
}
async function order(): Promise<Book> {
  return { isbn: "0-9", title: "Ferns" };
}
const books: Book[] = [{ isbn: "0-2", title: "Moss" }];
books.push({ isbn: "0-3", title: "Kelp", year: 1961 });
const byIsbn = new Map<string, Book>();
for (const book of books) byIsbn.set(book.isbn, book);
console.log(last<Book>(books).title, byIsbn.get("0-3")?.year, byIsbn.size, byIsbn.get("none") === undefined);
console.log(byIsbn.get("0-2") === books[0], [...books].sort((a, b) => (a.title < b.title ? -1 : 1))[0]!.isbn);
const batch: Batch<Book> = { rows: books };
console.log(batch.rows.length, batch.cursor === undefined);

// A member of a union.
function spine(x: Book | number | undefined): string {
  if (x === undefined) return "blank";
  if (typeof x === "number") return "no. " + x;
  return "book " + x.title;
}
function holder(x: Book | Member): string {
  return "card" in x ? "member " + x.name : "book " + x.title;
}
console.log(spine(undefined), spine(12), spine(books[1]), holder(ada), holder(books[0]!));

// Untyped data arrives through a checked conversion, as for a local interface.
const scanned = JSON.parse('{"isbn":"0-4","title":"Reeds","year":1988}') as Book;
const returned = JSON.parse('[{"isbn":"0-5","title":"Lichen"},{"isbn":"0-6","title":"Sedge"}]') as Book[];
const slip = JSON.parse(
  '{"ticket":"L1","condition":"good","book":{"isbn":"0-7","title":"Bracken"},"stamps":["in","out"]}',
) as Loan;
console.log(scanned.isbn, scanned.title, scanned.year, returned.length, returned[1]!.title, returned[0]!.year === undefined);
console.log(slip.condition, slip.book.title, slip.stamps.join(">"));

// Intersected, extended by a program interface, nested, spread.
type Priced = Book & { cents: number };
interface Signed extends Book {
  signer: string;
}
function label(book: Book): string {
  return book.title + " (" + book.isbn + (book.year === undefined ? "" : ", " + book.year) + ")";
}
const priced: Priced = { isbn: "0-8", title: "Heath", cents: 450 };
const signed: Signed = { isbn: "0-8", title: "Heath", signer: "Cy" };
console.log(priced.cents, label(priced), signed.signer, label(signed), JSON.stringify(signed));
const shelf: Shelf = { code: "B2", books: [{ isbn: "1-0", title: "Dunes" }] };
const loan: Loan = { ticket: "L2", condition: "good", book: shelf.books[0]!, stamps: ["out"] };
loan.condition = "worn";
const condition: Condition = loan.condition;
console.log(shelf.books.length, loan.book === shelf.books[0], condition === "worn", JSON.stringify(loan));
const reissued: Book = { ...books[0]!, year: 2020 };
const { isbn, ...details } = reissued;
console.log(Object.keys(books[0]!).join(","), Object.keys(reissued).join(","), isbn, JSON.stringify(details));

// Method and callback members are slots the program fills with its own closures.
const notes: string[] = [];
const counter: Counter = {
  unit: "copies",
  add(note: string) {
    notes.push(note + "+");
  },
};
counter.add("one");
counter.add("two");
const notices: Notices = { onReturn: (book) => book.title.toLowerCase() };
const silent: Notices = {};
console.log(notes.join(""), counter.unit, notices.onReturn?.(books[0]!), silent.onReturn === undefined);

order().then((book) => console.log(book.isbn, book.title));
