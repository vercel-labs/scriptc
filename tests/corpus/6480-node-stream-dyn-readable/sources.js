// JavaScript stream objects that are not native streams: a plain object
// implementing on/pipe, and a constructor function with its own listener
// table. Sinks: a plain object with write/end, and a constructor function
// that keeps listeners, so a native pipe() into it runs Node's protocol.

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

function Source(chunks) {
  this.chunks = chunks;
  this.listeners = {};
  this.readable = true;
  setImmediate(() => {
    for (const chunk of this.chunks) this.emit("data", chunk);
    this.emit("end");
  });
}
Source.prototype.on = function (event, listener) {
  (this.listeners[event] = this.listeners[event] || []).push(listener);
  return this;
};
Source.prototype.emit = function (event, value) {
  for (const listener of this.listeners[event] || []) listener(value);
  return true;
};
Source.prototype.pipe = function (dest) {
  this.on("data", (chunk) => dest.write(chunk));
  this.on("end", () => dest.end());
  return dest;
};

/** @returns {any} */
export function source(chunks) {
  return new Source(chunks);
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

function Sink(label) {
  this.label = label;
  this.parts = [];
  this.listeners = [];
  this.writable = true;
}
Sink.prototype.on = function (event, listener) {
  this.listeners.push({ event, listener, once: false });
  return this;
};
Sink.prototype.once = function (event, listener) {
  this.listeners.push({ event, listener, once: true });
  return this;
};
Sink.prototype.prependListener = function (event, listener) {
  this.listeners.unshift({ event, listener, once: false });
  return this;
};
Sink.prototype.removeListener = function (event, listener) {
  this.listeners = this.listeners.filter((l) => l.event !== event || l.listener !== listener);
  return this;
};
Sink.prototype.listenerCount = function (event) {
  return this.listeners.filter((l) => l.event === event).length;
};
Sink.prototype.emit = function (event, ...args) {
  const matching = this.listeners.filter((l) => l.event === event);
  this.listeners = this.listeners.filter((l) => l.event !== event || !l.once);
  for (const l of matching) l.listener(...args);
  return matching.length > 0;
};
Sink.prototype.write = function (chunk) {
  this.parts.push(String(chunk));
  return true;
};
Sink.prototype.end = function () {
  console.log(this.label, "ended with", this.parts.join("|"), "listening to", this.listeners.map((l) => l.event).join(","));
  this.emit("finish");
  console.log(this.label, "after finish listening to", this.listeners.map((l) => l.event).join(","));
};

/** @returns {any} */
export function sink(label) {
  return new Sink(label);
}

/** @returns {Promise<string>} */
export function jsCollect(stream) {
  return new Promise((resolve) => {
    const parts = [];
    stream.on("data", (chunk) => parts.push(String(chunk)));
    stream.on("end", () => resolve(parts.join("")));
  });
}

export function same(a, b) {
  return a === b;
}
