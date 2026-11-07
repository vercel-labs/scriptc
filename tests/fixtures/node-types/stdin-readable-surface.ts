// The Readable surface on process.stdin received as a Readable: setEncoding,
// pause and resume, 'readable' with read(), and async iteration, one after
// the other on the same stream. The pieces each phase sees depend on when
// the input arrives, so the program reports their kinds and their sum.
import type { Readable } from "node:stream";

function first(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    stream.setEncoding("utf8");
    const onData = (chunk: string) => {
      stream.off("data", onData);
      stream.pause();
      console.log("first", typeof chunk, chunk.length > 0, "paused", stream.isPaused());
      resolve(chunk);
    };
    stream.on("data", onData);
  });
}

function next(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    const onReadable = () => {
      const chunk = stream.read() as string | null;
      if (chunk === null) return;
      stream.off("readable", onReadable);
      console.log("read", typeof chunk, chunk.length > 0);
      resolve(chunk);
    };
    stream.on("readable", onReadable);
  });
}

async function rest(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk as string;
  return text;
}

async function main(stream: Readable): Promise<void> {
  const a = await first(stream);
  const b = await next(stream);
  const c = await rest(stream);
  console.log(JSON.stringify(a + b + c));
  console.log("ended", stream.readableEnded, stream.destroyed);
}
void main(process.stdin);
