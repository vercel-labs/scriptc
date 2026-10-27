// A constructor-function stream part with its own listener table, whose
// pipe() honors { end: false } and whose unpipe() detaches it, plus a
// JavaScript consumer that reads a stream to text.

function Part(chunks) {
  this.chunks = chunks;
  this.listeners = {};
  this.dest = null;
  this.ending = true;
  this.readable = true;
  setImmediate(() => {
    for (const chunk of this.chunks) {
      if (this.dest) this.dest.write(chunk);
      else this.emit("data", chunk);
    }
    if (this.dest && this.ending) this.dest.end();
    this.emit("end");
  });
}
Part.prototype.on = function (event, listener) {
  (this.listeners[event] = this.listeners[event] || []).push(listener);
  return this;
};
Part.prototype.emit = function (event, value) {
  for (const listener of this.listeners[event] || []) listener(value);
  return true;
};
Part.prototype.pipe = function (dest, options) {
  this.dest = dest;
  this.ending = !options || options.end !== false;
  return dest;
};
Part.prototype.unpipe = function () {
  console.log("part unpipe");
  this.dest = null;
  return this;
};
Part.prototype.pause = function () {
  console.log("part pause");
  return this;
};
Part.prototype.resume = function () {
  console.log("part resume");
  return this;
};
Part.prototype.setEncoding = function (encoding) {
  console.log("part setEncoding", encoding);
  return this;
};
Part.prototype.destroy = function () {
  console.log("part destroy");
};

/** @returns {Promise<any>} */
export async function openPart(chunks) {
  return new Part(chunks);
}

/** @returns {any} */
export function part(chunks) {
  return new Part(chunks);
}

/** @returns {any} */
export function streamToText(stream) {
  return new Promise((resolve) => {
    const parts = [];
    stream.on("data", (chunk) => parts.push(String(chunk)));
    stream.on("end", () => resolve(parts.join("")));
  });
}
