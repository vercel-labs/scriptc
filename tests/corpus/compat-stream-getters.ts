// readableAborted, readableDidRead, readableEncoding and writableAborted
// from typed code: on the class that created the stream, on a base class,
// and through `any`. writableAborted is read from Writable alone: Node's
// Duplex does not define it.
import { PassThrough, Readable, Transform, Writable } from "node:stream";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void => callback();

function readableState(value: Readable): string {
  const encoding: string | null = value.readableEncoding;
  const aborted: boolean = value.readableAborted;
  const didRead: boolean = value.readableDidRead;
  return `${aborted} ${didRead} ${encoding}`;
}
function writableState(value: Writable): string {
  const aborted: boolean = value.writableAborted;
  return String(aborted);
}
function anyState(value: any): string {
  return `${value.readableAborted} ${value.readableDidRead} ${value.readableEncoding} ${value.writableAborted}`;
}

async function main(): Promise<void> {
  // readableDidRead.
  const flowing = Readable.from(["a"]);
  console.log("flowing before", flowing.readableDidRead, readableState(flowing), "|", anyState(flowing));
  flowing.on("data", () => console.log("flowing data", flowing.readableDidRead));
  await turn();
  await turn();
  console.log("flowing after", flowing.readableDidRead, readableState(flowing), "|", anyState(flowing));

  const paused = new Readable({ read() {} });
  paused.push("x");
  console.log("paused before", paused.readableDidRead);
  console.log("paused read", String(paused.read()), paused.readableDidRead, readableState(paused));
  paused.destroy();

  const iterated = Readable.from(["a", "b"]);
  for await (const chunk of iterated) console.log("iterated chunk", String(chunk), iterated.readableDidRead);
  console.log("iterated after", readableState(iterated));

  // readableAborted.
  const destroyed = new Readable({ read() {} });
  console.log("aborted before", destroyed.readableAborted);
  destroyed.destroy();
  console.log("aborted after", destroyed.readableAborted, readableState(destroyed), "|", anyState(destroyed));
  const ended = Readable.from(["a"]);
  ended.resume();
  await turn();
  await turn();
  console.log("ended", ended.readableAborted, ended.destroyed, readableState(ended));

  // readableEncoding: a narrowed read, the option as written, setEncoding.
  const through = new PassThrough();
  const none = through.readableEncoding;
  console.log("encoding none", none === null ? "null" : none.toUpperCase(), readableState(through));
  through.setEncoding("hex");
  const hex = through.readableEncoding;
  console.log("encoding hex", hex === null ? "null" : hex.toUpperCase(), readableState(through), "|", anyState(through));
  through.setEncoding("binary");
  console.log("encoding binary set", through.readableEncoding);
  through.destroy();
  const spelled = new Readable({ encoding: "binary", read() {} });
  console.log("option binary", spelled.readableEncoding, readableState(spelled));
  spelled.setEncoding("utf8");
  console.log("option then set", spelled.readableEncoding);
  spelled.destroy();
  const wide = new Transform({
    encoding: "ucs2",
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  console.log("option ucs2", wide.readableEncoding, readableState(wide));
  wide.destroy();

  // writableAborted.
  const sink = new Writable({ write: noop });
  console.log("writable before", sink.writableAborted, writableState(sink), "|", anyState(sink));
  sink.destroy();
  console.log("writable after", sink.writableAborted, writableState(sink), "|", anyState(sink));
  const finished = new Writable({ write: noop });
  finished.end("x");
  await turn();
  console.log("writable finished", finished.writableAborted, writableState(finished));

  // closed: true once destroy() has run its _destroy, before 'close'.
  const closing = new Writable({ write: noop });
  closing.on("close", () => console.log("close event", closing.closed));
  console.log("closed before", closing.closed);
  closing.destroy();
  console.log("closed after destroy", closing.closed);
  await turn();
}

main();
