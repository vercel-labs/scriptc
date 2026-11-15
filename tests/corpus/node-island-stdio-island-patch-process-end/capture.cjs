let previous;

// Writes the text alone through the method it replaced: no chunk here
// carries an encoding or a callback.
exports.install = () => {
  previous = process.stdout.write;
  process.stdout.write = function (chunk) {
    const kind = typeof chunk === "string" ? "string" : Buffer.isBuffer(chunk) ? "Buffer" : typeof chunk;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return previous.call(this, `[island ${kind} ${this === process.stdout}] ${text}`);
  };
};
