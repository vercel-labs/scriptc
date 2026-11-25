// Writable.toWeb over a duck-typed writable whose writableHighWaterMark is
// negative or NaN: the WritableStream constructor refuses the strategy, the
// call throws Node's RangeError, and the discarded adapter keeps nothing —
// the sanitized lane's audit and the leak harness cover the retention.
import { Writable } from "node:stream";

function fake(highWaterMark) {
  const listeners = new Map();
  const target = {
    writable: true,
    destroyed: false,
    writableHighWaterMark: highWaterMark,
    write() {
      return true;
    },
    end() {
      target.writable = false;
    },
    destroy() {
      target.destroyed = true;
    },
    on(name, fn) {
      const list = listeners.get(name);
      if (list) list.push(fn);
      else listeners.set(name, [fn]);
    },
    removeListener() {},
  };
  return target;
}

for (const [label, highWaterMark] of [
  ["negative", -1],
  ["nan", Number.NaN],
]) {
  let first = null;
  let thrown = 0;
  for (let i = 0; i < 1000; i++) {
    try {
      Writable.toWeb(fake(highWaterMark));
    } catch (error) {
      thrown++;
      if (first === null) first = `${error.name} ${error.code} ${error.message}`;
    }
  }
  console.log(label, thrown, first);
}

// A well-formed duck writable still adapts and can be dropped.
for (let i = 0; i < 10; i++) {
  const web = Writable.toWeb(fake(16));
  web.getWriter().releaseLock();
}
console.log("done");
