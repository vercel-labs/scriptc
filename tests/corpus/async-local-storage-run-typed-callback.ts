// AsyncLocalStorage.run with a compiled callback whose parameters have
// static types: the store is entered for the call and restored after it,
// on return and on throw.
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
