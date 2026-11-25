// The state getters behind the predicates: readableAborted,
// readableDidRead, readableEncoding and writableAborted, read where the
// stream was created and through a function parameter. Node defines them
// per prototype: the readable ones are undefined on a Writable, and
// writableAborted exists on Writable alone, so a Duplex reads undefined.
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk, _encoding, callback) => callback();

// The four getters of a value that arrives untyped.
function untyped(value) {
  return [value.readableAborted, value.readableDidRead, value.readableEncoding, value.writableAborted]
    .map((answer) => String(answer))
    .join(" ");
}
function defines(value) {
  return ["readableAborted", "readableDidRead", "readableEncoding", "writableAborted"]
    .map((name) => name in value)
    .join(" ");
}
// The same question for the properties each side has always had.
function definesSides(value) {
  return ["readable", "readableLength", "writable", "writableLength", "writableCorked", "destroyed", "closed"]
    .map((name) => name in value)
    .join(" ");
}

// readableDidRead: a 'data' event was emitted, by a flowing stream, by
// read(), by for await or through a pipe.
{
  const flowing = Readable.from(["a"]);
  console.log("flowing before", flowing.readableDidRead, untyped(flowing));
  flowing.on("data", () => console.log("flowing data", flowing.readableDidRead));
  await turn();
  await turn();
  console.log("flowing after", flowing.readableDidRead, untyped(flowing));

  const paused = new Readable({ read() {} });
  paused.push("x");
  console.log("paused before", paused.readableDidRead);
  console.log("paused read", String(paused.read()), paused.readableDidRead, untyped(paused));
  paused.destroy();

  const iterated = Readable.from(["a", "b"]);
  console.log("iterated before", iterated.readableDidRead);
  for await (const chunk of iterated) console.log("iterated chunk", chunk, iterated.readableDidRead);
  console.log("iterated after", iterated.readableDidRead, untyped(iterated));

  const source = new PassThrough();
  const sink = new PassThrough();
  source.pipe(sink);
  console.log("piped before", source.readableDidRead, sink.readableDidRead);
  source.end("x");
  await turn();
  console.log("piped after", source.readableDidRead, sink.readableDidRead);
  sink.resume();
  await turn();
  console.log("piped drained", source.readableDidRead, sink.readableDidRead);
}

// readableAborted: destroyed or errored before 'end'.
{
  const destroyed = new Readable({ read() {} });
  console.log("aborted before", destroyed.readableAborted);
  destroyed.destroy();
  console.log("aborted after", destroyed.readableAborted, untyped(destroyed));

  const ended = Readable.from(["a"]);
  ended.resume();
  await turn();
  await turn();
  console.log("ended", ended.readableAborted, ended.destroyed, untyped(ended));

  const failed = new PassThrough();
  failed.on("error", () => {});
  failed.destroy(new Error("boom"));
  console.log("failed", failed.readableAborted, untyped(failed));
  await turn();
}

// readableEncoding: null, the encoding option as written, or the decoder
// setEncoding() installs.
{
  const plain = new PassThrough();
  console.log("encoding none", plain.readableEncoding, untyped(plain));
  plain.setEncoding("hex");
  console.log("encoding hex", plain.readableEncoding, untyped(plain));
  plain.setEncoding("binary");
  console.log("encoding binary set", plain.readableEncoding);
  plain.setEncoding("ucs2");
  console.log("encoding ucs2 set", plain.readableEncoding);
  plain.destroy();

  const option = new Readable({ encoding: "utf8", read() {} });
  console.log("option utf8", option.readableEncoding, untyped(option));
  const spelled = new Readable({ encoding: "binary", read() {} });
  console.log("option binary", spelled.readableEncoding, untyped(spelled));
  spelled.setEncoding("base64");
  console.log("option then set", spelled.readableEncoding);
  const wide = new Transform({
    encoding: "ucs2",
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  console.log("option ucs2", wide.readableEncoding);
  const objects = Readable.from(["a"]);
  console.log("from strings", objects.readableEncoding);
  option.destroy();
  spelled.destroy();
  wide.destroy();
  objects.destroy();
}

// writableAborted: destroyed or errored before 'finish'.
{
  const destroyed = new Writable({ write: noop });
  console.log("writable before", destroyed.writableAborted, untyped(destroyed));
  destroyed.destroy();
  console.log("writable after", destroyed.writableAborted, untyped(destroyed));

  const finished = new Writable({ write: noop });
  finished.end("x");
  await turn();
  console.log("writable finished", finished.writableAborted, finished.destroyed, untyped(finished));
}

// Which class defines which getter.
{
  const readable = new Readable({ read() {} });
  const writable = new Writable({ write: noop });
  const duplex = new Duplex({ read() {}, write: noop });
  const through = new PassThrough();
  console.log("Readable", untyped(readable), "|", defines(readable));
  console.log("Writable", untyped(writable), "|", defines(writable));
  console.log("Duplex", untyped(duplex), "|", defines(duplex));
  console.log("PassThrough", untyped(through), "|", defines(through));
  console.log("Duplex writableAborted", String(duplex.writableAborted), String(through.writableAborted));
  console.log("sides", definesSides(readable), "|", definesSides(writable), "|", definesSides(duplex));
}

// closed: true once destroy() has run its _destroy, before 'close'.
{
  const writable = new Writable({ write: noop });
  const readable = new Readable({ read() {} });
  writable.on("close", () => console.log("writable close", writable.closed));
  readable.on("close", () => console.log("readable close", readable.closed));
  console.log("closed before", writable.closed, readable.closed);
  writable.destroy();
  readable.destroy();
  console.log("closed after destroy", writable.closed, readable.closed);
  await turn();
  const slow = new Writable({
    write: noop,
    destroy(error, callback) {
      setTimeout(() => callback(error), 2);
    },
  });
  slow.destroy();
  console.log("slow destroy", slow.destroyed, slow.closed);
  await new Promise((resolve) => slow.once("close", resolve));
  console.log("slow closed", slow.closed);
}
