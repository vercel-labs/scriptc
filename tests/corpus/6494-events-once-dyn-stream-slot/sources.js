// A constructor-function stream with its own listener table.
function Part(chunks) {
  this.chunks = chunks;
  this.listeners = {};
  setImmediate(() => {
    for (const chunk of this.chunks) this.emit("data", chunk);
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

export function part(chunks) {
  return new Part(chunks);
}
