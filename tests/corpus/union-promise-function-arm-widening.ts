// A promise or function value flowing into a union whose only arm of that
// kind has a wider payload or result: the value converts into that arm.
// Promises keep their identity under === and !== against the union.

const chains = new Map<string, Promise<unknown>>();

async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const queued = (async () => {
    await previous.catch(() => {});
    return task();
  })();
  const tail = queued.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
    console.log(`settled ${key}: ${chains.get(key) !== tail}`);
  });
  return queued;
}

interface Store {
  pending?: Promise<unknown>;
  lookup?: (name: string) => Promise<string | null | undefined>;
  scale?: (n: number) => number | string;
}

async function findName(name: string): Promise<string | null> {
  return name.length > 3 ? name.toUpperCase() : null;
}

function double(n: number): number {
  return n * 2;
}

async function failing(): Promise<number | undefined> {
  throw new Error("task failed");
}

async function main(): Promise<void> {
  const a = await serialize("alpha", async () => 1);
  const b = await serialize("alpha", async () => "two");
  const c = await serialize("beta", async (): Promise<boolean | undefined> => true);
  console.log(a, b, c, chains.size);
  try {
    await serialize("alpha", failing);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  for (let i = 0; i < 4; i++) await Promise.resolve();
  console.log("remaining", chains.size);

  const store: Store = { lookup: findName, scale: double };
  const work: Promise<number> = Promise.resolve(41);
  store.pending = work;
  console.log(store.pending === work, store.pending !== work);
  const other: Promise<number> = Promise.resolve(41);
  console.log(store.pending === other);
  console.log(await store.pending);

  // One promise in two optional slots: each holds its own conversion.
  const second: Store = {};
  second.pending = work;
  console.log(store.pending === second.pending, store.pending !== second.pending);
  const slots: Store[] = [store, second, { pending: other }];
  console.log(slots.map((slot) => slot.pending === slots[0]!.pending).join(","));
  second.lookup = findName;
  console.log(store.lookup === second.lookup);

  const lookup = store.lookup;
  if (lookup) console.log(await lookup("abcd"), await lookup("ab"));
  console.log(store.scale?.(21));
  const empty: Store = {};
  console.log(empty.pending === work, empty.lookup === undefined, empty.scale?.(1));
}

main();
