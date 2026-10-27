// A native Readable piped straight into a JavaScript sink, the only
// untyped stream flow in the program; unpipe of a NodeJS.WritableStream
// that holds a native Writable or a JavaScript sink; unpipe() of every
// JavaScript sink; and JavaScript destinations whose prependListener or
// writableNeedDrain getter throws.
import { Readable, Writable } from "node:stream";
import { plainSink, throwingSink } from "./sources.js";

function detach(src: Readable, dst: NodeJS.WritableStream): void {
  src.unpipe(dst);
}

async function main(): Promise<void> {
  Readable.from(["a", "b"]).pipe(plainSink("direct"));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const parts: string[] = [];
  const native = new Writable({
    write(chunk: Buffer, _encoding, done) {
      parts.push(chunk.toString());
      done();
    },
  });
  native.on("unpipe", () => console.log("native heard unpipe"));
  const source = new Readable({ read() {} });
  source.pipe(native);
  detach(source, native);
  source.push("dropped");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  console.log("native got", JSON.stringify(parts.join("")), source.isPaused());

  const sink = plainSink("detached");
  const second = new Readable({ read() {} });
  second.pipe(sink);
  detach(second, sink);
  detach(second, plainSink("never piped"));
  second.push("late");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  console.log("second paused", second.isPaused());

  const third = new Readable({ read() {} });
  third.pipe(plainSink("first of two"));
  third.pipe(plainSink("second of two"));
  third.unpipe();
  third.push("after unpipe()");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  console.log("third paused", third.isPaused(), third.listenerCount("data"));

  for (const member of ["prependListener", "writableNeedDrain"]) {
    try {
      new Readable({ read() {} }).pipe(throwingSink(member));
      console.log(member, "piped");
    } catch (error) {
      console.log("pipe threw", (error as Error).message);
    }
  }
}

void main();
