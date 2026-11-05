// AsyncLocalStorage.run with a compiled callback whose parameters have
// static types: the store is entered for the call and restored after it,
// on return and on throw, and a record argument is the caller's own object,
// for synchronous, void and async callbacks.
import { AsyncLocalStorage } from "node:async_hooks";

type Request = { id: number; path: string; tags: string[] };

const storage = new AsyncLocalStorage<{ user: string }>();

function handle(request: Request, attempt: number): string {
  const store = storage.getStore();
  return `${request.path}#${request.id} attempt ${attempt} by ${store ? store.user : "nobody"} [${request.tags.join(",")}]`;
}

const request: Request = { id: 7, path: "/users", tags: ["a", "b"] };
console.log(storage.run({ user: "ada" }, handle, request, 1));
console.log(storage.getStore() === undefined);

const nested = storage.run({ user: "outer" }, (req: Request) => {
  const inner = storage.run({ user: "inner" }, handle, req, 2);
  return `${inner} / ${handle(req, 3)}`;
}, request);
console.log(nested);

function fail(req: Request): string {
  throw new Error(`failed ${req.id} as ${storage.getStore()?.user}`);
}
try {
  storage.run({ user: "grace" }, fail, request);
} catch (error) {
  console.log((error as Error).message);
}
console.log(storage.getStore() === undefined);

type Counter = { name: string; count: number; seen: string[] };
function bump(counter: Counter, by: number): number {
  counter.count += by;
  counter.seen.push(storage.getStore()?.user ?? "nobody");
  return counter.count;
}
const counter: Counter = { name: "hits", count: 1, seen: [] };
console.log(storage.run({ user: "lin" }, bump, counter, 2), counter.count, counter.seen);
console.log(storage.run({ user: "max" }, bump, counter, 3), counter.count, counter.seen);

function note(counter: Counter, text: string): void {
  counter.seen.push(`${text} ${storage.getStore()?.user}`);
}
storage.run({ user: "kim" }, note, counter, "noted");
console.log(counter.seen);

async function work(counter: Counter, delay: number): Promise<number> {
  counter.seen.push(`start ${storage.getStore()?.user}`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  counter.seen.push(`end ${storage.getStore()?.user}`);
  return counter.seen.length;
}
const slow: Counter = { name: "slow", count: 0, seen: [] };
const fast: Counter = { name: "fast", count: 0, seen: [] };
const pending = [storage.run({ user: "slow" }, work, slow, 5), storage.run({ user: "fast" }, work, fast, 1)];
console.log(storage.getStore() === undefined, slow.seen, fast.seen);
(async () => {
  const lengths = [await pending[0]!, await pending[1]!];
  console.log(lengths, slow.seen, fast.seen);
})();
