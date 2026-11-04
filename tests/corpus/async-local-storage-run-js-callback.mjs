// AsyncLocalStorage.run from JavaScript with a callback and its arguments:
// the callback sees the store and the caller's own objects, run returns
// what the callback returns (undefined for one that returns nothing), and
// the store is restored after the call.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

function record(log, label) {
  log.push(`${label} in ${storage.getStore()}`);
  return log.length;
}

function silent(log, label) {
  log.push(`${label} quietly in ${storage.getStore()}`);
}

const log = [];
console.log(storage.run("first", record, log, "a"));
console.log(storage.run("second", silent, log, "b"));
console.log(storage.getStore(), log);

const nested = storage.run("outer", (inner, label) => {
  const count = storage.run("inner", record, inner, label);
  return `${count} ${storage.getStore()}`;
}, log, "c");
console.log(nested, log);
