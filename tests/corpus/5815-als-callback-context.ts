// AsyncLocalStorage context reaches timer, interval, setImmediate,
// process.nextTick and queueMicrotask callbacks: each runs in the store
// that was active when it was scheduled, including callbacks they schedule
// in turn, an interval on every tick, and a refreshed timer. A cleared
// timer or immediate never runs. enterWith inside a callback lasts until
// the callback returns, also in a callback scheduled outside any store,
// and callbacks scheduled outside any store, or inside exit(), see
// undefined. A store entered at the top level reaches only the callbacks
// scheduled after it.
import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<string>();
const users = new AsyncLocalStorage<string>();
const seen: string[] = [];

function record(where: string): void {
  seen.push(`${where}: ${requests.getStore() ?? "-"} ${users.getStore() ?? "-"}`);
}

requests.run("req-1", () => {
  setTimeout(() => {
    record("timeout");
    process.nextTick(() => record("tick from timeout"));
    queueMicrotask(() => record("microtask from timeout"));
  }, 1);
  setImmediate(() => {
    record("immediate");
    setTimeout(() => record("timeout from immediate"), 1);
  });
  process.nextTick(() => record("tick"));
  queueMicrotask(() => record("microtask"));
  users.run("ada", () => {
    setTimeout(() => record("nested timeout"), 2);
    setImmediate(() => record("nested immediate"));
  });
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    record(`interval ${ticks}`);
    if (ticks === 3) clearInterval(interval);
  }, 1);
  const refreshed = setTimeout(() => record("refreshed timeout"), 3);
  refreshed.refresh();
  const cleared = setTimeout(() => record("cleared timeout"), 1);
  clearTimeout(cleared);
  const clearedImmediate = setImmediate(() => record("cleared immediate"));
  clearImmediate(clearedImmediate);
  requests.exit(() => {
    setTimeout(() => record("timeout in exit"), 1);
    queueMicrotask(() => record("microtask in exit"));
  });
});

requests.run("req-2", () => {
  setTimeout(() => {
    users.enterWith("grace");
    record("timeout after enterWith");
    setTimeout(() => record("timeout from enterWith"), 1);
  }, 4);
  setTimeout(() => record("timeout after the enterWith timeout"), 5);
});

setTimeout(() => {
  record("timeout outside any store");
  requests.enterWith("entered outside");
}, 1);
setTimeout(() => record("timeout after one that entered outside any store"), 8);
process.nextTick(() => record("tick outside any store"));

setTimeout(() => {
  record("final");
  for (const line of seen.sort()) console.log(line);
}, 30);

users.enterWith("top level");
setTimeout(() => record("timeout after a top-level enterWith"), 6);
