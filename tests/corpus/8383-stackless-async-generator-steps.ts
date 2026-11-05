// Typed async generators whose bodies suspend only at their own awaits and
// yields: number, string and object channels, values passed into next(),
// return() and throw() while the body awaits, finally blocks that await,
// yield* delegation, and an async function consuming them.
const log: string[] = [];
const later = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 1));

async function* numbers(n: number): AsyncGenerator<number, string, void> {
  try {
    for (let i = 0; i < n; i++) {
      yield i % 2 === 0 ? i : await later(i);
    }
    return "numbers done";
  } finally {
    await later(0);
    log.push("numbers finally");
  }
}

async function* accumulate(): AsyncGenerator<number, number, number> {
  let total = 0;
  for (;;) {
    const v = yield total;
    if (v < 0) return total;
    total += await Promise.resolve(v);
  }
}

interface Point {
  x: number;
  y: number;
}
async function* points(n: number): AsyncGenerator<Point> {
  for (let i = 0; i < n; i++) {
    await null;
    yield { x: i, y: i * i };
  }
}

async function* labels(): AsyncGenerator<string, void, undefined> {
  yield "first";
  yield* (async function* () {
    yield "inner one";
    yield await later("inner two");
  })();
  yield "last";
}

async function sum(it: AsyncGenerator<number, string, void>): Promise<number> {
  let s = 0;
  for await (const v of it) s += v;
  return s;
}

async function main(): Promise<void> {
  console.log("sum", await sum(numbers(6)));
  console.log(log.splice(0).join(" | "));

  const acc = accumulate();
  console.log(JSON.stringify(await acc.next(0)));
  for (const v of [1, 2, 3]) console.log(JSON.stringify(await acc.next(v)));
  console.log(JSON.stringify(await acc.next(-1)));
  console.log(JSON.stringify(await acc.next(5)));

  for await (const p of points(3)) console.log(p.x, p.y);

  const words: string[] = [];
  for await (const w of labels()) words.push(w);
  console.log(words.join(", "));

  const it = numbers(10);
  console.log(JSON.stringify(await it.next()));
  const pending = it.next();
  const ret = it.return("returned");
  console.log(JSON.stringify(await pending), JSON.stringify(await ret));
  console.log(log.splice(0).join(" | "));

  const thrower = numbers(4);
  await thrower.next();
  try {
    await thrower.throw(new Error("thrown in"));
  } catch (e) {
    console.log("rejected:", (e as Error).message);
  }
  console.log(JSON.stringify(await thrower.next()));
  console.log(log.splice(0).join(" | "));

  const order: string[] = [];
  const run = (async () => {
    for await (const v of numbers(3)) order.push(`v${v}`);
  })();
  void Promise.resolve()
    .then(() => order.push("m1"))
    .then(() => order.push("m2"));
  await run;
  console.log(order.join(" "));
  log.splice(0);
}
await main();
