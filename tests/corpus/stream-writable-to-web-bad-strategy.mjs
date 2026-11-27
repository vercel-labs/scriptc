// Writable.toWeb over a duck-typed writable whose writableHighWaterMark is
// negative or NaN: the WritableStream constructor refuses the strategy, the
// call throws Node's RangeError, and the discarded adapter keeps nothing —
// the sanitized lane's audit and the leak harness cover the retention.
import { Writable } from "node:stream";

function fake(highWaterMark) {
  const listeners = new Map();
  const emit = (name, arg) => {
    for (const fn of listeners.get(name) ?? []) fn(arg);
  };
  const target = {
    writable: true,
    destroyed: false,
    writableHighWaterMark: highWaterMark,
    write() {
      return true;
    },
    end() {
      target.writable = false;
      setImmediate(() => {
        emit("finish");
        emit("close");
      });
    },
    destroy() {
      target.destroyed = true;
      setImmediate(() => emit("close"));
    },
    on(name, fn) {
      const list = listeners.get(name);
      if (list) list.push(fn);
      else listeners.set(name, [fn]);
      return target;
    },
    removeListener(name, fn) {
      const list = listeners.get(name);
      if (list) listeners.set(name, list.filter((entry) => entry !== fn));
      return target;
    },
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

// A well-formed duck writable still adapts; closing the stream releases the
// adapter. A dropped WritableStream keeps its adapter until it closes, and
// the sanitized lane's audit fails any runtime value still live at exit.
for (let i = 0; i < 10; i++) {
  const writer = Writable.toWeb(fake(16)).getWriter();
  await writer.close();
}
console.log("done");
