// A plain JavaScript sink, and sinks whose prependListener or
// writableNeedDrain getter throws.

/** @returns {any} */
export function plainSink(label) {
  const parts = [];
  const listeners = {};
  const sink = {
    write(chunk) {
      parts.push(String(chunk));
      return true;
    },
    end() {
      console.log(label, "sink end", parts.join(""));
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return sink;
    },
    once(event, listener) {
      return sink.on(event, listener);
    },
    removeListener(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener);
      return sink;
    },
    emit(event, ...args) {
      if (event === "unpipe") console.log(label, "heard unpipe");
      for (const listener of listeners[event] ?? []) listener(...args);
      return true;
    },
  };
  return sink;
}

/** @returns {any} */
export function throwingSink(member) {
  const sink = plainSink(member);
  Object.defineProperty(sink, member, {
    get() {
      throw new Error(`${member} getter failed`);
    },
  });
  return sink;
}
