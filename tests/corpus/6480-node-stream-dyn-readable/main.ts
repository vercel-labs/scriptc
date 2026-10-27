// NodeJS.ReadableStream slots hold native streams and JavaScript stream
// objects alike: a plain object implementing on/pipe, a constructor-function
// stream, and a native Readable pass through a TypeScript function typed
// NodeJS.ReadableStream. TypeScript consumes them with on("data") and
// pipe() into a native Writable, JavaScript consumes the returned values
// (the same objects), and a native Readable typed NodeJS.ReadableStream
// pipes into JavaScript sinks through Node's pipe protocol.
import { Readable, Writable } from "node:stream";
import { jsCollect, plainSink, plainSource, same, sink, source } from "./sources.js";

function pass(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return stream;
}

async function collect(label: string, stream: NodeJS.ReadableStream): Promise<void> {
  const parts: string[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer | string) => parts.push(chunk.toString()));
    stream.on("end", () => resolve());
  });
  console.log(label, "on data", parts.join(""));
}

async function pipeInto(label: string, stream: NodeJS.ReadableStream): Promise<void> {
  const parts: string[] = [];
  await new Promise<void>((resolve) => {
    const native = new Writable({
      write(chunk: Buffer, _encoding, done) {
        parts.push(chunk.toString());
        done();
      },
    });
    native.on("finish", () => resolve());
    stream.pipe(native);
  });
  console.log(label, "pipe", parts.join(""));
}

async function main(): Promise<void> {
  await collect("plain", pass(plainSource(["p1", "p2"])));
  await collect("constructor", pass(source(["s1", "s2"])));
  await collect("native", pass(Readable.from(["n1", "n2"])));

  await pipeInto("plain", pass(plainSource(["p3", "p4"])));
  await pipeInto("constructor", pass(source(["s3", "s4"])));
  await pipeInto("native", pass(Readable.from(["n3", "n4"])));

  console.log("plain js", await jsCollect(pass(plainSource(["p5", "p6"]))));
  console.log("constructor js", await jsCollect(pass(source(["s5", "s6"]))));
  console.log("native js", await jsCollect(pass(Readable.from(["n5", "n6"]))));

  const plain = plainSource(["p7"]);
  const made = source(["s7"]);
  const native = Readable.from(["n7"]);
  console.log("identity", same(plain, pass(plain)), same(made, pass(made)), same(native, pass(native)));

  await new Promise<void>((resolve) => {
    pass(Readable.from(["n8", "n9"])).pipe(plainSink("native into plain"));
    pass(plainSource(["p8"])).pipe(plainSink("plain into plain"));
    setTimeout(resolve, 20);
  });

  await new Promise<void>((resolve) => {
    const target = sink("native into constructor");
    target.on("pipe", () => console.log("sink heard pipe"));
    target.on("unpipe", () => console.log("sink heard unpipe"));
    target.on("finish", () => setImmediate(resolve));
    pass(Readable.from(["n10", "n11"])).pipe(target);
  });
}

void main();
