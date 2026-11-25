// Promise.all's tuple form with entries that are not promises at all
// (records, arrays, numbers, strings, undefined and null fulfil as
// themselves, with their identity), over `[...] as const`, and over a
// tuple-typed variable (`const trio = [a(), b(), c()] as const;
// Promise.all(trio)`), which lists the same entries as the literal.
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
async function getBook(): Promise<Book> {
  return later({ isbn: "b1", title: "atlas" }, 3);
}
async function getReader(): Promise<Reader> {
  return later({ name: "ada", age: 36 }, 1);
}

async function plainEntries(): Promise<void> {
  const [n, s, b] = await Promise.all([later(1, 2), "plain", false]);
  console.log(n, s, b);
  const units = await Promise.all([later(1, 2), undefined, null, 7]);
  console.log(units[0], units[1], units[2], units[3], units.length);
  const place = { shelf: "north", copies: 2 };
  const xs = [1, 2, 3];
  const [book, c, ys] = await Promise.all([getBook(), place, xs]);
  console.log(book.title, c.shelf, c.copies, ys.length, c === place, ys === xs);
  const allPlain = await Promise.all([1, "two", place]);
  console.log(allPlain[0], allPlain[1], allPlain[2].shelf, allPlain.length);
  const dates = await Promise.all([new Date(0), new Map([["k", 1]]), getReader()]);
  console.log(dates[0].toISOString(), dates[1].get("k"), dates[2].name);
}

async function constLiteral(): Promise<void> {
  const [a, b] = await Promise.all([later(1, 3), getReader()] as const);
  console.log(a, b.name);
  const [c, d] = await Promise.all(([getBook(), "plain"] as const));
  console.log(c.title, d);
}

async function tupleVariables(): Promise<void> {
  const trio = [getBook(), getReader(), later({ ok: true }, 1)] as const;
  const [book, reader, flag] = await Promise.all(trio);
  console.log(book.title, reader.name, flag.ok);
  const t: [Promise<number>, Promise<string>] = [later(1, 3), later("s", 1)];
  const [a, b] = await Promise.all(t);
  console.log(a + 1, b);
  const uniform: [Promise<number>, Promise<number>] = [later(4, 2), later(5, 1)];
  const sums = await Promise.all(uniform);
  console.log(sums[0] + sums[1], sums.length);
  const mixed = [getReader(), 5, "five"] as const;
  const out = await Promise.all(mixed);
  console.log(out[0].age, out[1], out[2]);
  // The tuple is read when Promise.all is called: a later write is not seen.
  const live: [Promise<string>, Promise<number>] = [later("first", 1), later(1, 1)];
  const pending = Promise.all(live);
  live[0] = later("second", 1);
  console.log((await pending)[0]);
}

async function main(): Promise<void> {
  await plainEntries();
  await constLiteral();
  await tupleVariables();
}

main().catch((e: unknown) => {
  console.log("main rejected:", e instanceof Error ? e.message : String(e));
});
