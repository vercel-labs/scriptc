import { Registry, describe, titleIndex } from "./registry.js";

// Records keep the key order their object literals write when values of
// the same type also pass through checked conversions that build none of
// them:
//  - a typed method the program may replace on its instance (the
//    computed-key write in registry.js makes every method name replaceable)
//    returns the records it stores, checked back from the guarded call;
//  - an index spec from JavaScript, checked into a type whose function
//    field takes a Book, receives Books but never builds one.
// JSON, Object.keys and spreads of those records follow insertion order,
// not the interface's declared order.
interface Book {
  id: string;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

type Draft = { title: string; author: string };

interface IndexSpec<T> {
  name: string;
  key: (row: T) => string;
}

class Repository<T extends { id: string }> {
  readonly #rows = new Map<string, T>();

  insert(row: T): T {
    this.#rows.set(row.id, row);
    return row;
  }

  require(id: string): T {
    const row = this.#rows.get(id);
    if (row === undefined) throw new Error(`missing ${id}`);
    return row;
  }

  find(id: string): T | undefined {
    return this.#rows.get(id);
  }

  all(): T[] {
    return [...this.#rows.values()];
  }
}

class Service {
  readonly #books = new Repository<Book>();
  readonly #index: IndexSpec<Book> = titleIndex;
  #clock = 0;

  #now(): string {
    this.#clock++;
    return `t${this.#clock}`;
  }

  create(draft: Draft, id: string): Book {
    const at = this.#now();
    return this.#books.insert({ ...draft, id, createdAt: at, updatedAt: at });
  }

  update(id: string, patch: Partial<Draft>): Book {
    const current = this.#books.require(id);
    return this.#books.insert({ ...current, ...patch, updatedAt: this.#now() });
  }

  get(id: string): Book {
    return this.#books.require(id);
  }

  maybe(id: string): Book | undefined {
    return this.#books.find(id);
  }

  list(): Book[] {
    return this.#books.all();
  }

  indexed(): string[] {
    return this.list().map((book) => `${this.#index.name}=${this.#index.key(book)}`);
  }
}

const registry = new Registry();
console.log(describe(registry));

const service = new Service();
console.log(JSON.stringify(service.create({ title: "Dune", author: "Herbert" }, "b1")));
console.log(JSON.stringify(service.create({ title: "Earthsea", author: "Le Guin" }, "b2")));
console.log(JSON.stringify(service.update("b1", { title: "Dune Messiah" })));
console.log(Object.keys(service.get("b2")).join(","));
const found = service.maybe("b1");
if (found !== undefined) console.log(JSON.stringify(found));
console.log(JSON.stringify(service.list()));
const copy = { ...service.get("b1") };
console.log(Object.keys(copy).join(","));
console.log(service.indexed().join(" "));
try {
  service.get("missing");
} catch (error) {
  console.log((error as Error).message);
}
