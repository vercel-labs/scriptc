// for await over classes whose [Symbol.asyncIterator]() or [Symbol.iterator]()
// returns an iterator object: early exits await return(), as in Node.
class Ticks {
  readonly n: number;
  constructor(n: number) { this.n = n; }
  [Symbol.asyncIterator]() {
    let i = 0;
    const n = this.n;
    return {
      async next(): Promise<IteratorResult<number>> {
        return i < n ? { value: i++, done: false } : { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<number>> {
        console.log("closed at", i);
        return { value: undefined, done: true };
      },
    };
  }
}
class Pages {
  [Symbol.asyncIterator](): PageCursor { return new PageCursor(); }
}
class PageCursor {
  page = 0;
  async next(): Promise<{ value: string; done: boolean }> {
    this.page++;
    return this.page <= 3 ? { value: "page " + this.page, done: false } : { value: "", done: true };
  }
}
class Letters {
  [Symbol.iterator]() {
    const letters = ["x", "y", "z"];
    let i = 0;
    return {
      next(): IteratorResult<string> { return i < letters.length ? { value: letters[i++]!, done: false } : { value: undefined, done: true }; },
    };
  }
}
async function main(): Promise<void> {
  let sum = 0;
  for await (const v of new Ticks(4)) sum += v * 2;
  console.log("sum", sum);
  for await (const v of new Ticks(5)) {
    if (v === 2) break;
    console.log("early", v);
  }
  try {
    for await (const v of new Ticks(5)) if (v === 1) throw new Error("body " + v);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  async function find(): Promise<number> {
    for await (const v of new Ticks(9)) if (v > 2) return v;
    return -1;
  }
  console.log("found", await find());
  for await (const p of new Pages()) console.log(p);
  for await (const l of new Letters()) console.log("letter", l);
}
main();
