// AsyncLocalStorage.bind, AsyncLocalStorage.snapshot and the constructor
// options, as in Node.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

// bind(fn) runs fn in the context active at the bind, with its arguments.
const add = store.run("bound", () =>
  AsyncLocalStorage.bind((a: number, b: number) => `${store.getStore()}:${a + b}`),
);
console.log(add(1, 2));
console.log(store.run("other", () => add(3, 4)));

// A function bound outside any store sees no store inside run().
const plain = AsyncLocalStorage.bind(() => store.getStore());
console.log(store.run("ignored", () => plain()));

// The bound function keeps its result type.
const length = store.run("len", () => AsyncLocalStorage.bind((s: string) => s.length));
console.log(length("four") * 2);

// snapshot() runs a function in the context of the snapshot.
const snap = store.run("snapshot", () => AsyncLocalStorage.snapshot());
console.log(snap(() => store.getStore()));
console.log(store.run("later", () => snap(() => store.getStore())));
console.log(snap((x: number, y: number) => x * y, 6, 7));

// A store entered inside the bound call ends with it.
const enter = store.run("start", () =>
  AsyncLocalStorage.bind(() => {
    store.enterWith("entered");
    return store.getStore();
  }),
);
console.log(enter(), store.getStore());

// The default value and the name.
const config = new AsyncLocalStorage<{ level: number }>({
  defaultValue: { level: 1 },
  name: "config",
});
console.log(config.name, config.getStore()?.level);
config.run({ level: 2 }, () => console.log("run", config.getStore()?.level));
config.exit(() => console.log("exit", config.getStore()));
config.disable();
console.log("disabled", config.getStore()?.level);
const unnamed = new AsyncLocalStorage<number>();
console.log(JSON.stringify(unnamed.name), unnamed.getStore());
const empty = new AsyncLocalStorage<number>({});
console.log(JSON.stringify(empty.name), empty.getStore());
// A class instance's fields are options too.
class StoreOptions {
  defaultValue = 7;
  name = "from-class";
}
const fromClass = new AsyncLocalStorage<number>(new StoreOptions());
console.log(fromClass.name, fromClass.getStore());

// Bound functions and snapshots carry the context across asynchronous work.
const later = store.run("timer", () => AsyncLocalStorage.bind(() => store.getStore()));
await new Promise<void>((resolve) =>
  setTimeout(() => {
    console.log("in timer", later(), store.getStore());
    resolve();
  }, 1),
);
