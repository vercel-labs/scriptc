// AsyncLocalStorage.bind, snapshot and the constructor options over
// untyped values, as in Node.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs";

const store = new AsyncLocalStorage();

function sum(a, b) {
  return [this?.tag, a + b, store.getStore()];
}
const bound = store.run("bound", () => AsyncLocalStorage.bind(sum));
console.log(bound.name, bound.length, bound === sum, typeof bound);
console.log(JSON.stringify(bound.call({ tag: "receiver" }, 1, 2)));
console.log(JSON.stringify(store.run("other", () => bound(3, 4))));

const snap = store.run("snapshot", () => AsyncLocalStorage.snapshot());
console.log(snap.name, snap.length, typeof snap);
console.log(snap((a, b) => `${store.getStore()} ${a + b}`, 2, 3));

for (const attempt of [
  () => AsyncLocalStorage.bind(5),
  () => AsyncLocalStorage.bind("fn"),
  () => snap(5),
  () => snap(),
]) {
  try {
    console.log("ok", attempt());
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}

for (const options of [1, "x", null, true]) {
  try {
    new AsyncLocalStorage(options);
    console.log("ok", options);
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
const named = new AsyncLocalStorage({ name: "named", defaultValue: 0 });
console.log(named.name, named.getStore());
named.run(5, () => console.log(named.getStore()));
console.log(new AsyncLocalStorage(undefined).name === "");

// The options are read as JavaScript reads properties: inherited values
// and getters count, defaultValue is read once and name twice, and the
// name becomes a string.
const inherited = new AsyncLocalStorage(Object.create({ defaultValue: "inherited", name: "proto" }));
console.log(inherited.getStore(), inherited.name);
const reads = [];
const viaGetters = new AsyncLocalStorage({
  get defaultValue() {
    reads.push("defaultValue");
    return "getter";
  },
  get name() {
    reads.push("name");
    return "getter-name";
  },
});
console.log(viaGetters.getStore(), viaGetters.name, reads.join(","));
const coerced = [5, null, { toString: () => "object" }].map((name) => new AsyncLocalStorage({ name }).name);
console.log(JSON.stringify(coerced));
for (const options of [
  {
    get defaultValue() {
      throw new Error("from a getter");
    },
  },
  { name: Symbol("s") },
]) {
  try {
    new AsyncLocalStorage(options);
    console.log("constructed");
  } catch (error) {
    console.log(error.name, error.message);
  }
}

// A snapshot calls its callback with an undefined receiver, also when the
// snapshot itself is called as a method.
const kind = function () {
  return this === undefined ? "undefined" : typeof this;
};
const holder = { snap, tag: "holder" };
console.log(snap(kind), holder.snap(kind), snap.call({ tag: "receiver" }, kind));

// An untyped callback runs in the stores of its call.
store.run("readFile", () =>
  readFile(import.meta.filename, "utf8", (error, text) =>
    console.log("readFile", store.getStore(), error === null, text.length > 0),
  ),
);
