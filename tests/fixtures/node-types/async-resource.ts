/* AsyncResource typed by @types/node: the class, its constructor options,
 * runInAsyncScope's generic result, bind's function-typed result and the
 * static bind all lower natively with @types/node's declarations in place
 * (the shipped fallback declares the same surface). The binary's output
 * must match Node's. */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

const resource = new AsyncResource("FIXTURE", { triggerAsyncId: 1 });
console.log("ids:", typeof resource.asyncId(), resource.asyncId() >= 2, resource.triggerAsyncId());

store.run("captured", () => {
  const inner = new AsyncResource("INNER");
  const value: string = inner.runInAsyncScope(() => store.getStore() ?? "missing");
  console.log("scope:", value);
  const reader: () => string = inner.bind(() => store.getStore() ?? "missing");
  console.log("bound:", reader());
});

const double = AsyncResource.bind((value: number) => value * 2, "DOUBLE");
console.log("static bind:", double(21), double.name, double.length);

console.log("destroy:", resource.emitDestroy() === resource);
