// A plain JavaScript source implementing on/pipe and a plain sink with
// write/end.

/** @returns {any} */
export function plainSource(chunks) {
  const listeners = {};
  const source = {
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return source;
    },
    emit(event, value) {
      for (const listener of listeners[event] ?? []) listener(value);
    },
    pipe(dest) {
      source.on("data", (chunk) => dest.write(chunk));
      source.on("end", () => dest.end());
      return dest;
    },
  };
  setImmediate(() => {
    for (const chunk of chunks) source.emit("data", chunk);
    source.emit("end");
  });
  return source;
}

/** @returns {any} */
export function plainSink(label) {
  const parts = [];
  return {
    write(chunk) {
      parts.push(String(chunk));
      return true;
    },
    end() {
      console.log(label, "sink end", parts.join(""));
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  };
}
