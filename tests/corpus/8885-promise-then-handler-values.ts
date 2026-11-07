// `then` with handler values the settled type does not spell exactly, and
// handler values on the promises the static combinators return.
async function failing<T>(message: string): Promise<T> {
  throw new Error(message);
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
async function load(n: number): Promise<number> {
  if (n === 2) throw new Error("two");
  return n * 10;
}

const wider = (value: number | string): string => "wider " + value;
const withUnit = (value: number, unit?: string): string => "with unit " + value + " " + String(unit);
const rest = (...values: number[]): number => values.length;
async function later(value: number): Promise<string> {
  await null;
  return "later " + value;
}
const onError = (e: unknown): string => "error " + messageOf(e);
const zero = (_e: unknown): number => 0;

class Sink {
  prefix = "sink";
  take(value: number): string {
    return this.prefix + " " + value;
  }
  keep = (value: number): string => this.prefix + " kept " + value;
}
// The executor's own resolve and reject as handlers.
function relay(n: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    load(n).then(resolve).catch(reject);
  });
}
function relayBoth(n: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    load(n).then(resolve, reject);
  });
}
function callbackStyle(n: number, done: (error?: Error | null, value?: number) => void): void {
  load(n)
    .then((value) => done(null, value))
    .catch(done);
}
function labelled(label: string): (value: number) => string {
  return (value) => label + " " + value;
}

async function main(): Promise<void> {
  console.log(await Promise.resolve(1).then(wider));
  console.log(await Promise.resolve(2).then(withUnit));
  console.log(await Promise.resolve(3).then(rest));
  console.log(await Promise.resolve(4).then(later));

  const sink = new Sink();
  console.log(await Promise.resolve(5).then(sink.take.bind(sink)));
  console.log(await Promise.resolve(6).then(sink.keep));
  console.log(await Promise.resolve(7).then(labelled("call result")));
  for (const first of [true, false]) {
    console.log(await Promise.resolve(8).then(first ? labelled("first") : labelled("second")));
  }

  // Both handlers as values.
  console.log(await Promise.resolve(9).then(wider, onError));
  console.log(await failing<number>("ten").then(wider, onError));
  console.log(await Promise.resolve(11).then(withUnit, onError));
  console.log(await Promise.resolve(12).then(String, onError));
  console.log(await failing<number>("thirteen").then(String, onError));
  console.log(await Promise.resolve(true).then(Number, zero));

  // An optional fulfillment handler: called when present, and absent it
  // passes the settled value through.
  const seen: string[] = [];
  const record: ((value: number) => void) | undefined = (value) => {
    seen.push("recorded " + value);
  };
  const absent: ((value: number) => void) | undefined = seen.length > 0 ? record : undefined;
  await Promise.resolve(14).then(record);
  await Promise.resolve(15).then(absent);
  console.log(seen.join(","));

  // Promises from the static combinators.
  const allFailed = (e: unknown): number[] => {
    console.log("all failed:", messageOf(e));
    return [];
  };
  console.log(await Promise.all([load(1), load(2)]).catch(allFailed));
  console.log(await Promise.all([load(1), load(3)]).catch(allFailed));
  console.log(await Promise.all([1, 2, 3].map((n) => load(n).catch(zero))));
  console.log(await Promise.all([1, 3].map(load)));
  console.log(await Promise.race([load(1), load(3)]).then(wider, onError));
  console.log(await Promise.race([load(2), load(3)]).then(wider).catch(onError));
  const fulfilledCount = (results: PromiseSettledResult<number>[]): number =>
    results.filter((r) => r.status === "fulfilled").length;
  console.log(await Promise.allSettled([load(1), load(2), load(3)]).then(fulfilledCount));
  const aggregate = (e: unknown): number => (e instanceof AggregateError ? e.errors.length : -1);
  console.log(await Promise.any([load(2), load(2)]).catch(aggregate));
  console.log(await Promise.resolve(16).catch(zero), await Promise.reject(new Error("r")).catch(zero));
  const work = (): number => {
    throw new Error("sync");
  };
  console.log(await Promise.try(work).catch(zero));
  const { promise, reject } = Promise.withResolvers<number>();
  const guarded = promise.catch(zero);
  reject(new Error("resolvers"));
  console.log(await guarded);

  console.log(await relay(1), await relay(2).catch(onError));
  console.log(await relayBoth(3), await relayBoth(2).catch(onError));
  callbackStyle(1, (error, value) => console.log("callback", error ? error.message : "none", value));
  callbackStyle(2, (error, value) => console.log("callback", error ? error.message : "none", value));
  await load(1);

  // Chains and results that are not awaited.
  const log = (e: unknown): void => console.log("logged", messageOf(e));
  const done = (n: number): void => console.log("done", n);
  const maybe: Promise<void> | undefined = seen.length > 0 ? failing<void>("optional chain") : undefined;
  await maybe?.catch(log);
  await load(1).then(done).catch(log);
  await load(2).then(done).catch(log);
  await load(2).then(done, log);
  const a = load(1).catch(zero);
  const b = load(2).catch(zero);
  console.log(await a, await b);
  void load(2).catch(log);
  load(2)
    .catch(log)
    .finally(() => console.log("end"));
}

void main();
