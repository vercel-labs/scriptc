// readable.push() of an empty Buffer outside object mode adds nothing, as
// in Node: the chunks pushed after it still reach 'data' listeners,
// readline and read(), and push(null) still ends the stream. In object
// mode an empty Buffer is a value like any other.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

function lines(chunks: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const src = new Readable({ read() {} });
    const rl = createInterface({ input: src, crlfDelay: Infinity });
    rl.on("line", (line: string) => console.log("line", JSON.stringify(line)));
    rl.on("close", () => {
      console.log("readline closed");
      resolve();
    });
    for (const chunk of chunks) src.push(Buffer.from(chunk, "utf8"));
    src.push(null);
  });
}

function data(): Promise<void> {
  return new Promise<void>((resolve) => {
    const src = new Readable({ read() {} });
    src.on("data", (chunk: Buffer) => console.log("data", JSON.stringify(String(chunk))));
    src.on("end", () => {
      console.log("data end");
      resolve();
    });
    console.log("push a", src.push(Buffer.from("a")));
    console.log("push empty", src.push(Buffer.alloc(0)));
    console.log("push b", src.push(Buffer.from("b")));
    src.push(null);
  });
}

function paused(): void {
  const src = new Readable({ read() {} });
  src.push(Buffer.from("x"));
  src.push(Buffer.alloc(0));
  src.push(Buffer.from("y"));
  console.log("readableLength", src.readableLength);
  console.log("read", JSON.stringify(String(src.read())));
}

function objectMode(): Promise<void> {
  return new Promise<void>((resolve) => {
    const src = new Readable({ objectMode: true, read() {} });
    src.on("data", (chunk: Buffer) => console.log("object chunk length", chunk.length));
    src.on("end", () => {
      console.log("object end");
      resolve();
    });
    src.push(Buffer.alloc(0));
    src.push(Buffer.from("z"));
    src.push(null);
  });
}

async function main(): Promise<void> {
  await lines(["a\nb", "", "c\n"]);
  await lines(["", "", "only\n"]);
  await data();
  paused();
  await objectMode();
  console.log("done");
}

main();
