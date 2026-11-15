// Promise.allSettled over an array literal of different promise types, and
// over a tuple-typed value: the checker's tuple of settled results, one
// `{ status, value } | { status, reason }` per position. Each record has
// Node's keys in Node's order; a fulfilled value keeps its type and
// identity; a reason is the rejected value itself. Entries that are not
// promises fulfil as themselves, and an entry that is a promise or nothing
// settles either way.
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
async function findBook(flag: boolean): Promise<Book | undefined> {
  return flag ? getBook() : undefined;
}
async function findReader(flag: boolean): Promise<Reader | null> {
  return flag ? getReader() : null;
}
async function noop(): Promise<void> {
  await later(0, 1);
}

const yes = process.argv.length < 99;

async function statusChecks(): Promise<void> {
  const [first, second] = await Promise.allSettled([getReader(), getTags()]);
  if (first.status === "fulfilled") console.log(first.value.name, first.value.age);
  else console.log("rejected", String(first.reason));
  const tags = second.status === "rejected" ? [] : second.value;
  console.log(tags.length, second.status);
  const [a, b, c] = await Promise.allSettled([getBook(), fail("no", 1), later(7, 2)]);
  console.log(a.status, a.status === "fulfilled" ? a.value.title : "-");
  console.log(b.status, b.status === "rejected" ? (b.reason as Error).message : "-");
  console.log(c.status, c.status === "fulfilled" ? c.value + 1 : "-");
  const [m, down] = await Promise.allSettled([findBook(false), fail("down", 1)]);
  console.log(
    m.status === "fulfilled" ? m.value === undefined : "rej",
    down.status === "rejected" ? (down.reason as Error).message : "ok",
  );
  if (down.status === "rejected") {
    const reason: unknown = down.reason;
    console.log(reason instanceof Error);
  }
  const [nobody, shelved] = await Promise.allSettled([
    yes ? later<Reader | null>(null, 1) : findReader(true),
    getBook(),
  ]);
  console.log(nobody.status === "fulfilled" ? nobody.value === null : "-", shelved.status === "fulfilled" ? shelved.value.title : "-");
}

async function recordShapes(): Promise<void> {
  const [v, w] = await Promise.allSettled([noop(), getBook()]);
  console.log(JSON.stringify(v), JSON.stringify(w), Object.keys(v).join(","), Object.keys(w).join(","));
  const pair = await Promise.allSettled([getTags(), fail("no", 1)]);
  console.log(pair.length, pair[0].status, pair[1].status, Object.keys(pair[1]).join(","));
  const book = { isbn: "same", title: "same" };
  const err = new RangeError("same");
  const [f, g, h] = await Promise.allSettled([Promise.reject(err), later(book, 1), later(1, 1)]);
  console.log(f.status === "rejected" && f.reason === err, g.status === "fulfilled" && g.value === book, h.status);
  const [s, n, u] = await Promise.allSettled([
    Promise.reject("str") as Promise<number>,
    Promise.reject(42) as Promise<string>,
    Promise.reject(undefined) as Promise<Book>,
  ]);
  for (const r of [s, n, u]) {
    if (r.status === "rejected") console.log(typeof r.reason, r.reason === undefined ? "undefined" : JSON.stringify(r.reason));
  }
}

async function otherEntries(): Promise<void> {
  const place = { shelf: "north" };
  const rs = await Promise.allSettled([
    yes ? fail("armed", 1) : undefined,
    yes ? undefined : getBook(),
    place,
    5,
  ]);
  console.log(rs.map((r) => r.status).join(","), rs[0].status === "rejected" ? (rs[0].reason as Error).message : "-");
  console.log(JSON.stringify(rs[1]), JSON.stringify(rs[2]), JSON.stringify(rs[3]));
  console.log(rs[2].status === "fulfilled" && rs[2].value === place);
  const pair = [getBook(), getReader()] as const;
  const [t, u] = await Promise.allSettled(pair);
  console.log(t.status, u.status, t.status === "fulfilled" ? t.value.title : "-");
  const results = await Promise.allSettled([getTags(), getBook(), fail("third", 1)]);
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(failed, results.length);
  // One promise type keeps the array form.
  const [x, y] = await Promise.allSettled([getReader(), getReader()]);
  console.log(x.status, y.status === "fulfilled" ? y.value.age : "-");
}

async function main(): Promise<void> {
  await statusChecks();
  await recordShapes();
  await otherEntries();
}

main().catch((e: unknown) => {
  console.log("main rejected:", e instanceof Error ? e.message : String(e));
});
