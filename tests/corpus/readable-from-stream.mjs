// Readable.from(stream) wraps a readable node stream as a fresh object-mode
// stream (highWaterMark 1) that yields the stream's chunks; the source keeps
// its own life-cycle (destroying the wrapper does not destroy it), and a
// source error reaches the wrapper.
import { Duplex, PassThrough, Readable } from "node:stream";

const drain = async (stream) => {
  const out = [];
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) =>
      out.push(`${typeof chunk}:${Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)}`),
    );
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return out.join(",");
};

{
  const inner = new PassThrough();
  const wrapped = Readable.from(inner);
  console.log(
    "modes",
    wrapped.readableObjectMode,
    wrapped.readableHighWaterMark,
    wrapped === inner,
  );
  inner.write("hi");
  inner.end("!");
  console.log("chunks", await drain(wrapped), "source destroyed", inner.destroyed);
}

{
  const inner = new Duplex({
    read() {},
    write(_chunk, _enc, callback) {
      callback();
    },
  });
  inner.push("x");
  inner.push(null);
  console.log("duplex", await drain(Readable.from(inner)));
}

{
  const inner = new PassThrough();
  const wrapped = Readable.from(inner, { encoding: "hex" });
  inner.end(Buffer.from("hi"));
  console.log("encoded", await drain(wrapped), JSON.stringify(wrapped.readableEncoding));
}

{
  const log = [];
  const pick = () => {
    log.push("pick");
    return "hex";
  };
  const inner = new PassThrough();
  const wrapped = Readable.from(inner, { encoding: pick() });
  inner.end(Buffer.from("hi"));
  console.log("dynamic encoding", log.join(","), await drain(wrapped), JSON.stringify(wrapped.readableEncoding));
}

{
  const inner = new PassThrough();
  const wrapped = Readable.from(inner, { encoding: "" });
  inner.end(Buffer.from("hi"));
  console.log("falsy encoding", JSON.stringify(wrapped.readableEncoding), await drain(wrapped));
}

{
  const inner = new PassThrough();
  const wrapped = Readable.from(inner);
  const failure = new Promise((resolve) =>
    wrapped.on("error", (error) => resolve(`${error.name}: ${error.message}`)),
  );
  inner.on("error", () => {});
  wrapped.on("data", () => {});
  inner.destroy(new Error("boom"));
  console.log("error", await failure);
}

{
  const inner = new PassThrough();
  const wrapped = Readable.from(inner);
  wrapped.on("data", () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  wrapped.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log("destroyed", inner.destroyed, wrapped.destroyed);
}
