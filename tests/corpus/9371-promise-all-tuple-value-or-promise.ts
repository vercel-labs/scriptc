// Promise.all over an array literal whose entries are not all promises of
// their own: an entry that is a promise or nothing (`cond ? fetch() :
// undefined`, `: null`), a value or a promise of it (`cond ? [] : fetch()`,
// a value already at hand), and an entry whose position is `{}`. Node resolves each
// entry: a promise is adopted, every other value fulfils as itself. The
// result is the checker's tuple, read by destructuring (a declaration and an
// assignment) and by index. Also pinned: an entry keeps its identity, a
// rejection through the promise arm rejects the result, and every entry is
// evaluated once, in order, before any is resolved.
interface Book {
  isbn: string;
  title: string;
}
interface Reader {
  name: string;
  age: number;
}

function later<T>(v: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));
}
function fail(msg: string, ms: number): Promise<never> {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}
async function getBook(): Promise<Book> {
  return later({ isbn: "b1", title: "atlas" }, 3);
}
async function getReader(): Promise<Reader> {
  return later({ name: "ada", age: 36 }, 1);
}
async function getTags(): Promise<string[]> {
  return later(["a", "b"], 2);
}
async function shelfOrNull(go: boolean): Promise<Book[] | null> {
  return go ? [await getBook()] : null;
}
function onLoan(hit: boolean): Book | Promise<Book> {
  return hit ? { isbn: "b2", title: "lent" } : getBook();
}
function maybeReader(go: boolean): Promise<Reader> | undefined {
  return go ? getReader() : undefined;
}

// Decided at run time, so neither arm folds away.
const yes = process.argv.length < 99;
const no = !yes;

async function promiseOrNothing(): Promise<void> {
  const [book, reader] = await Promise.all([getBook(), no ? getReader() : undefined]);
  console.log(book.title, reader === undefined);
  const [t2, u2] = await Promise.all([getBook(), yes ? getReader() : undefined]);
  console.log(t2.isbn, u2?.name);
  const [t3, u3] = await Promise.all([getBook(), no ? getReader() : null]);
  console.log(t3.isbn, u3 === null);
  const [a, b, t4] = await Promise.all([maybeReader(true), maybeReader(false), getBook()]);
  console.log(a?.name, b === undefined, t4.title);
  // A promise of a nullable value, or null itself.
  const [u, some, none] = await Promise.all([
    getReader(),
    yes ? shelfOrNull(true) : null,
    no ? shelfOrNull(true) : null,
  ]);
  console.log(u.name, some ? some.length : "null", none === null);
  const [x, y] = await Promise.all([yes ? shelfOrNull(false) : null, no ? getBook() : undefined]);
  console.log(x === null, y === undefined);
}

async function valueOrPromise(): Promise<void> {
  const [hit, miss] = await Promise.all([onLoan(true), onLoan(false)]);
  console.log(hit.title, miss.title);
  const [t, n] = await Promise.all([getBook(), no ? later(1, 1) : 7]);
  console.log(t.isbn, n);
  // The empty array literal beside a promise of the array.
  const [list, book] = await Promise.all([no ? [] : getTags(), getBook()]);
  console.log(list.length, book.title);
  const [l2, t2] = await Promise.all([no ? getTags() : [], getBook()]);
  console.log(l2.length, t2.title);
  // Destructuring assignment, and a position typed `{}`.
  let marks: { a?: number; b?: number };
  let tags: string[];
  [marks, tags] = await Promise.all([no ? {} : later({ a: 1 }, 1), getTags()]);
  console.log(marks.a, tags.join(","));
  [marks, tags] = await Promise.all([no ? later({ b: 2 }, 1) : {}, getTags()]);
  console.log(marks.a, marks.b, tags.join(","));
}

async function identityAndRejection(): Promise<void> {
  const place = { shelf: "north" };
  const [same, other] = await Promise.all([yes ? place : later(place, 1), yes ? later(place, 1) : place]);
  console.log(same === place, other === place);
  try {
    await Promise.all([getBook(), yes ? fail("through the promise arm", 1) : undefined]);
    console.log("no throw");
  } catch (e) {
    console.log((e as Error).message);
  }
  let calls = 0;
  const next = (): number => ++calls;
  const [p, q, r] = await Promise.all([next(), yes ? later(next(), 2) : undefined, next()]);
  console.log(p, q, r, calls);
  const pair = await Promise.all([getBook(), no ? getReader() : undefined]);
  console.log(pair.length, pair[0].title, pair[1]);
}

async function main(): Promise<void> {
  await promiseOrNothing();
  await valueOrPromise();
  await identityAndRejection();
}

main().catch((e: unknown) => {
  console.log("main rejected:", e instanceof Error ? e.message : String(e));
});
