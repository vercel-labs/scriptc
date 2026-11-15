const seen = [];
let previous;

function decode(chunk, encoding) {
  if (typeof chunk !== "string") return Buffer.from(chunk).toString("utf8");
  return typeof encoding === "string" ? Buffer.from(chunk, encoding).toString("utf8") : chunk;
}

exports.install = (label) => {
  previous = process.stdout.write;
  process.stdout.write = function (chunk, encoding, callback) {
    const kind = typeof chunk === "string" ? "string" : Buffer.isBuffer(chunk) ? "Buffer" : "bytes";
    const done = typeof encoding === "function" ? encoding : callback;
    const text = decode(chunk, encoding);
    seen.push(
      `${label} ${kind} ${typeof encoding} ${typeof callback} ${this === process.stdout} ${JSON.stringify(text)}`,
    );
    return previous.call(this, `[${label}] ${text}`, done);
  };
};

exports.restore = () => {
  process.stdout.write = previous;
};

exports.write = (chunk) => process.stdout.write(chunk);

exports.attempt = (chunk) => {
  try {
    process.stdout.write(chunk);
    return "no error";
  } catch (error) {
    return `${error instanceof RangeError} ${error.message}`;
  }
};

exports.refuse = () => {
  previous = process.stdout.write;
  process.stdout.write = (chunk) => {
    throw new TypeError(`island refuses ${String(chunk).trimEnd()}`);
  };
};

exports.state = () =>
  `island sees the restored stream: ${process.stdout.write === previous}, ${process.stdout.write === process.stderr.write}`;

exports.seen = () => seen.join("\n");
