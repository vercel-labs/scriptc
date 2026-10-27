// Typed Duplex.from bodies that declare the options argument: an async
// generator function and an async function.
import { Duplex } from "node:stream";

const d = Duplex.from(async function* (source: AsyncIterable<string>, opts: { signal: AbortSignal }) {
  opts.signal.addEventListener("abort", () => console.log("aborted", opts.signal.aborted));
  for await (const chunk of source) {
    yield `<${chunk}>`;
  }
});
d.on("data", (c: string) => console.log("data", c));
d.on("end", () => console.log("end"));
d.on("close", () => {
  console.log("close");
  const w = Duplex.from(async function (source: AsyncIterable<string>, { signal }: { signal: AbortSignal }): Promise<void> {
    let n = 0;
    for await (const chunk of source) n += chunk.length;
    console.log("total", n, signal.aborted);
  });
  w.on("finish", () => console.log("finish"));
  w.on("close", () => console.log("w close"));
  w.write("abc");
  w.end("de");
});
d.write("x");
d.end("y");
