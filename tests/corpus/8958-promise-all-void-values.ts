// Promise.all over promises of nothing fulfills with one undefined value per
// entry, as its type Promise<void[]> says: read through a binding, an
// annotation, a class field, a generic function, a reaction and a loop.
// Where nothing reads the array the forms that always worked still do.
const log: string[] = [];
async function step(n: number): Promise<void> {
  await null;
  log.push(`s${n}`);
}
const xs = [1, 2, 3];
const done = (): string => log.splice(0).join();

function pass<T>(p: Promise<T>): Promise<T> {
  return p;
}
function observed<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    void operation.then(
      (value) => resolve(value),
      (error: unknown) => reject(error),
    );
  });
}
async function all(): Promise<void[]> {
  return Promise.all(xs.map((n) => step(n)));
}
class Box {
  pending: Promise<void[]> | undefined;
  start(): void {
    this.pending = Promise.all(xs.map((n) => step(n)));
  }
}
async function failing(n: number): Promise<void> {
  await null;
  if (n === 2) throw new Error(`failed ${n}`);
}

async function main(): Promise<void> {
  // Nothing reads the array.
  await Promise.all(xs.map((n) => step(n)));
  console.log("statement", done());
  void Promise.all(xs.map((n) => step(n)));
  await Promise.all(xs.map((n) => step(n))).then(() => console.log("then without a value", done()));
  await Promise.all(xs.map((n) => step(n))).finally(() => console.log("finally"));
  await Promise.all(xs.map((n) => step(n))).catch(() => {});
  console.log("catch", done());

  // The array is read.
  const r = await Promise.all(xs.map((n) => step(n)));
  console.log("awaited", r.length, r[0] === undefined, JSON.stringify(r), Array.isArray(r), 0 in r, done());
  const p = Promise.all(xs.map((n) => step(n)));
  await p;
  console.log("binding", done());
  const held = Promise.all(xs.map((n) => step(n)));
  held.then((v) => console.log("then on a binding", v.length));
  console.log("binding awaited", (await held).length, done());
  const annotated: Promise<void[]> = Promise.all([step(1), step(2)]);
  console.log("annotated", (await annotated).length, done());
  const pair = Promise.all([step(1), step(2)]);
  const both = await pair;
  console.log("literal binding", both.length, both[0] === undefined, done());
  const unknown: Promise<unknown> = Promise.all(xs.map((n) => step(n)));
  console.log("unknown", Array.isArray(await unknown), done());
  console.log("generic", (await pass(Promise.all(xs.map((n) => step(n))))).length, done());
  const controller = new AbortController();
  const through = Promise.all(xs.map((n) => step(n)));
  console.log("generic executor", (await observed(through, controller.signal)).length, done());
  console.log("returned", (await all()).length, done());
  console.log("reaction", await Promise.all(xs.map((n) => step(n))).then((v) => v.length), done());
  const box = new Box();
  box.start();
  console.log("field", (await box.pending)?.length, done());
  for (const value of await Promise.all(xs.map((n) => step(n)))) console.log("loop", value === undefined);
  done();
  const empty: number[] = [];
  const none = await Promise.all(empty.map((n) => step(n)));
  console.log("empty", none.length, Array.isArray(none));
  const values = await Promise.all(xs.map((n) => step(n)));
  values.push(undefined);
  console.log("its own array", values.length, values.map((v) => typeof v).join(), done());

  // A rejection passes through either form.
  try {
    await Promise.all(xs.map((n) => failing(n)));
  } catch (e) {
    console.log("rejected statement", (e as Error).message);
  }
  try {
    const rejected = await Promise.all(xs.map((n) => failing(n)));
    console.log("not reached", rejected.length);
  } catch (e) {
    console.log("rejected value", (e as Error).message);
  }

  // The turn the result settles on.
  const order: string[] = [];
  let turns = Promise.resolve();
  for (let i = 1; i <= 4; i++) turns = turns.then(() => void order.push(`turn ${i}`));
  const settled = Promise.all([Promise.resolve(), Promise.resolve()] as Promise<void>[]);
  void settled.then((v) => order.push(`values ${v.length}`));
  await turns;
  console.log(order.join(", "));
}

main().catch((e) => console.log("rejected", String(e)));
