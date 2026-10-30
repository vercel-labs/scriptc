// Literals that start by spreading a record JavaScript built keep that
// record's key order, as Node does: a draft from JavaScript spread into a
// new record, a self copy of a record JavaScript stored or returned, and
// a wider view of either. Native drafts and copies keep the literal order.
import { replace, storeRow, validate } from "./lib.js";

interface Book {
  id: string;
  title: string;
  year: number;
  tags: readonly string[];
  createdAt: string;
  version: number;
}

type Draft = Omit<Book, "id" | "createdAt" | "version">;
type Patch = Partial<Draft>;

interface Availability {
  copies: number;
  onLoan: number;
}

type BookView = Book & { availability: Availability };

class Repository {
  private readonly rows = new Map<string, Book>();
  private sequence = 0;

  create(draft: Draft): Book {
    const book: Book = {
      ...draft,
      tags: [...draft.tags].sort(),
      id: `bk_${++this.sequence}`,
      createdAt: "t" + this.sequence,
      version: 1,
    };
    this.rows.set(book.id, book);
    return book;
  }

  require(id: string): Book {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error("missing " + id);
    return row;
  }

  update(id: string, patch: Patch): Book {
    const current = this.require(id);
    const next: Book = { ...current, ...patch, version: current.version + 1 };
    this.rows.set(id, next);
    return next;
  }

  view(book: Book): BookView {
    return { ...book, availability: { copies: 2, onLoan: book.version } };
  }

  table(): Map<string, Book> {
    return this.rows;
  }
}

function show(label: string, value: Book): void {
  console.log(label, JSON.stringify(value));
  console.log(" keys", Object.keys(value).join());
}

function showView(label: string, value: BookView): void {
  console.log(label, JSON.stringify(value));
  console.log(" keys", Object.keys(value).join());
}

const repo = new Repository();

// A native draft: the literal's order.
const native = repo.create({ title: "Native", year: 1990, tags: ["b", "a"] });
show("native", native);
showView("native view", repo.view(native));
show("native update", repo.update(native.id, { year: 1991 }));

// A draft JavaScript built in another order.
const draft: Draft = validate({ title: "Checked", year: 2020, tags: ["z", "y"] });
const checked = repo.create(draft);
show("checked", checked);
showView("checked view", repo.view(checked));
show("checked update", repo.update(checked.id, { title: "Checked 2" }));
showView("checked update view", repo.view(repo.require(checked.id)));

// A row JavaScript stored into the typed map.
storeRow(repo.table(), "js_1");
show("stored", repo.require("js_1"));
show("stored update", repo.update("js_1", { tags: ["s"] }));
showView("stored view", repo.view(repo.require("js_1")));

// A replacement method returning rows JavaScript builds.
replace(repo, "require");
show("replaced", repo.require("x"));
show("replaced update", repo.update("x", { year: 2002 }));
showView("replaced view", repo.view(repo.require("y")));

// The copies are independent records.
const again = repo.view(checked);
showView("again", again);
console.log(native.version, checked.version, again.availability.onLoan);

// An integer-named key the spread source lacks comes first, as Node
// creates integer keys first whatever the literal's order.
interface Ranked {
  year: number;
  title: string;
  tags: readonly string[];
  id: string;
  "1": string;
}
function rank(source: Draft, id: string): Ranked {
  return { ...source, id, "1": "gold" };
}
for (const ranked of [rank(draft, "r1"), rank({ title: "Native", year: 1990, tags: [] }, "r2")]) {
  console.log("ranked", JSON.stringify(ranked));
  console.log(" keys", Object.keys(ranked).join());
}
