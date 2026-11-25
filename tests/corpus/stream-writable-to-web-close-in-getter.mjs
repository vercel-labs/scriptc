// A writable-like sink whose `write` getter emits 'close' and answers a
// callable, with the adapter as the sink's only owner: the getter runs while
// the adapter is retiring and dropping its reference to the sink, so the
// target has to survive the whole member lookup and call. Node rejects the
// write because the emitted close closed the WritableStream; the callable is
// never reached.
import { Writable } from "node:stream";

function makeSink(state) {
  // The listener bus is the sink's own transport, held outside the sink so
  // no closure of the sink refers back to it.
  const listeners = new Map();
  const bus = {
    on(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    off(name, fn) {
      const list = listeners.get(name) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
  };
  return {
    writableNeedDrain: false,
    writableHighWaterMark: 16,
    writableEnded: false,
    on: bus.on,
    off: bus.off,
    removeListener: bus.off,
    get write() {
      bus.emit("close");
      return (chunk, callback) => {
        state.calls.push(chunk.length);
        if (callback) callback();
        return true;
      };
    },
    end(callback) {
      if (callback) callback();
    },
    destroy() {},
  };
}

// The adapter is the sink's only owner once this returns: the call's
// argument temporary dies with the frame.
function adapt(state) {
  return Writable.toWeb(makeSink(state));
}

const state = { calls: [] };
const web = adapt(state);
const writer = web.getWriter();

const outcome = await writer.write(new Uint8Array([1, 2])).then(
  () => "resolved",
  (error) => `${error.name} ${error.message}`,
);
console.log("closed in getter", outcome, state.calls.length);

const closeOutcome = await writer.close().then(
  () => "closed",
  (error) => `${error.name} ${error.message}`,
);
console.log("close after", closeOutcome);
