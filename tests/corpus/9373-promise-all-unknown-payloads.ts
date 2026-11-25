// Promise.all over Promise<unknown>[] and Promise<any>[]: the checker's
// result is `unknown[]` / `any[]`, one checked-dynamic array holding each
// fulfilled value. The forms: awaited as a statement (an array awaited only
// for completion), the array read afterwards, a mapped array, and a
// rejection.
interface Book {
  isbn: string;
  title: string;
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
async function noop(): Promise<void> {
  await later(0, 1);
}

async function main(): Promise<void> {
  const pending: Promise<unknown>[] = [getBook()];
  pending.push(later(1, 1));
  await Promise.all(pending);
  console.log("done");
  const rs = await Promise.all(pending);
  console.log(rs.length, typeof rs[0], typeof rs[1], Array.isArray(rs));
  const first = rs[0] as Book;
  console.log(first.title);
  const mapped = await Promise.all([1, 2].map((n): Promise<unknown> => later(n * 2, 1)));
  console.log(mapped.length, mapped[0], JSON.stringify(mapped));
  const none: Promise<unknown>[] = [];
  console.log((await Promise.all(none)).length);
  try {
    const failing: Promise<unknown>[] = [getBook(), fail("unknown-reject", 1)];
    await Promise.all(failing);
    console.log("no throw");
  } catch (e) {
    console.log((e as Error).message);
  }
  const anys: Promise<any>[] = [later(1, 1), later("s", 1)];
  await Promise.all(anys);
  console.log("awaited");
  const closing: Promise<any>[] = [];
  closing.push(noop());
  closing.push(getBook());
  await Promise.all(closing);
  console.log("closed");
}

main().catch((e: unknown) => {
  console.log("main rejected:", e instanceof Error ? e.message : String(e));
});
