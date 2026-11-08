// Generic generator methods, sync and async, driven by hand: `.next()` with sent values,
// `.return()`, `.throw()` (caught inside and uncaught), and the order `finally` blocks run in.
class Feed {
  seen: string[] = [];
  *each<T>(xs: T[]): Generator<T, string, number | undefined> {
    let sent = 0;
    try {
      for (const x of xs) {
        const got = yield x;
        if (got !== undefined) sent += got;
      }
    } catch (e) {
      this.seen.push(`caught ${(e as Error).message}`);
      return `recovered ${sent}`;
    } finally {
      this.seen.push("finally");
    }
    return `done ${sent}`;
  }
  async *eachAsync<T>(xs: T[]): AsyncGenerator<T, string, undefined> {
    try {
      for (const x of xs) {
        await Promise.resolve();
        yield x;
      }
    } finally {
      this.seen.push("async finally");
    }
    return "async done";
  }
}
const f = new Feed();
const a = f.each([1, 2, 3]);
console.log(a.next(undefined), a.next(5), a.next(6), a.next(7), a.next(undefined));
const b = f.each(["a", "b"]);
console.log(b.next(undefined), b.return("early"), b.next(undefined));
const c = f.each([true, false]);
console.log(c.next(undefined), c.throw(new Error("x")), c.next(undefined));
console.log(f.seen.join(","));
const d = f.eachAsync([1, 2]);
console.log(await d.next(), await d.next(), await d.next(), await d.next());
const e = f.eachAsync(["p", "q"]);
console.log(await e.next(), await e.return("stop"), await e.next());
const g = f.eachAsync([9]);
console.log(await g.next());
try {
  await g.throw(new Error("thrown in"));
} catch (err) {
  console.log("rethrown", (err as Error).message);
}
console.log(f.seen.join(","));
